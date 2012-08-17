// This simple script allows the client to take control of the device
// and send a spike to reload the browser.
// http://www.youtube.com/watch?v=mIq9jFdEfZo#t=2m03 "Spike"

/* TASKS

1. Create iframe that sends messages to and from current window
2. On message reload, not before storing some information
3. Need to store current scroll position (and zoom?)
4. Reload

5. Capture error messages and send down spike

6. Report errors via spike (to where?)
7. Create server that allows a spike to be sent to specific id

*/

// Found @yaffle's EventSource polyfill to be superb (over my own)
/*jslint indent: 2, vars: true */
/*global setTimeout, clearTimeout */

(function (global) {
  "use strict";

  function EventTarget() {
    this.listeners = {};
    return this;
  }

  EventTarget.prototype = {
    listeners: null,
    throwError: function (e) {
      setTimeout(function () {
        throw e;
      }, 0);
    },
    invokeEvent: function (event) {
      var type = String(event.type);
      var phase = event.eventPhase;
      var listeners = this.listeners;
      var typeListeners = listeners[type];
      if (!typeListeners) {
        return;
      }
      var candidates = typeListeners[phase === 1 ? 0 : (phase === 3 ? 2 : 1)];
      var length = candidates.length;
      var i = 0;
      while (i < length) {
        event.currentTarget = this;
        try {
          if (candidates[i]) {
            candidates[i].call(this, event);
          }
        } catch (e) {
          this.throwError(e);
        }
        event.currentTarget = null;
        i += 1;
      }
    },
    dispatchEvent: function (event) {
      event.eventPhase = 2;
      this.invokeEvent(event);
    },
    addEventListener: function (type, callback, capture) {
      type = String(type);
      capture = capture ? 0 : 2;
      var listeners = this.listeners;
      var typeListeners = listeners[type];
      if (!typeListeners) {
        listeners[type] = typeListeners = [[], [], []];
      }
      var x = typeListeners[capture];
      var i = x.length;
      while (i > 0) {
        i -= 1;
        if (x[i] === callback) {
          return;
        }
      }
      x.push(callback);
      typeListeners[2 - capture].push(null);
      typeListeners[1].push(callback);
    },
    removeEventListener: function (type, callback, capture) {
      type = String(type);
      capture = capture ? 0 : 2;
      var listeners = this.listeners;
      var typeListeners = listeners[type];
      if (!typeListeners) {
        return;
      }
      var x = typeListeners[capture];
      var length = x.length;
      var filtered = [[], [], []];
      var i = 0;
      while (i < length) {
        if (x[i] !== callback) {
          filtered[0].push(typeListeners[0][i]);
          filtered[1].push(typeListeners[1][i]);
          filtered[2].push(typeListeners[2][i]);
        }
        i += 1;
      }
      if (filtered[0].length === 0) {
        delete listeners[type];
      } else {
        listeners[type] = filtered;
      }
    }
  };

  // http://blogs.msdn.com/b/ieinternals/archive/2010/04/06/comet-streaming-in-internet-explorer-with-xmlhttprequest-and-xdomainrequest.aspx?PageIndex=1#comments
  // XDomainRequest does not have a binary interface. To use with non-text, first base64 to string.
  // http://cometdaily.com/2008/page/3/

  var XHR = global.XMLHttpRequest,
    xhr2 = XHR && global.ProgressEvent && ((new XHR()).withCredentials !== undefined),
    Transport = xhr2 ? XHR : global.XDomainRequest,
    CONNECTING = 0,
    OPEN = 1,
    CLOSED = 2,
    endOfLine = /\r[\s\S]|\n/, // after "\r" should be some character
    proto;

  function empty() {}

  function EventSource(url, options) {
    url = String(url);

    var that = this,
      retry = 1000,
      retry2 = retry,
      heartbeatTimeout = 45000,
      xhrTimeout = null,
      wasActivity = false,
      lastEventId = '',
      xhr = new Transport(),
      reconnectTimeout = null,
      withCredentials = Boolean(xhr2 && options && options.withCredentials),
      offset,
      charOffset,
      opened,
      dataBuffer = '',
      lastEventIdBuffer = '',
      eventTypeBuffer = '',
      tail = {
        next: null,
        event: null,
        readyState: null
      },
      head = tail,
      channel = null;

    options = null;
    that.url = url;

    that.readyState = CONNECTING;
    that.withCredentials = withCredentials;

    // Queue a task which, if the readyState is set to a value other than CLOSED,
    // sets the readyState to ... and fires event

    function onTimeout() {
      var event = head.event,
        readyState = head.readyState,
        type = String(event.type);
      head = head.next;

      if (that.readyState !== CLOSED) { // http://www.w3.org/Bugs/Public/show_bug.cgi?id=14331
        if (readyState !== null) {
          that.readyState = readyState;
        }

        if (readyState === CONNECTING) {
          // setTimeout will wait before previous setTimeout(0) have completed
          if (retry2 > 21600000) {
            retry2 = 21600000;
          }
          reconnectTimeout = setTimeout(openConnection, retry2);
          retry2 = retry2 * 2 + 1;
        }

        event.target = that;
        that.dispatchEvent(event);

        if ((type === 'message' || type === 'error' || type === 'open') && typeof that['on' + type] === 'function') {
          // as IE 8 doesn't support getters/setters, we can't implement 'onmessage' via addEventListener/removeEventListener
          that['on' + type](event);
        }
      }
    }

    // MessageChannel support: IE 10, Opera 11.6x?, Chrome ?, Safari ?
    if (global.MessageChannel) {
      channel = new global.MessageChannel();
      channel.port1.onmessage = onTimeout;
    }

    function queue(event, readyState) {
      tail.event = event;
      tail.readyState = readyState;
      tail = tail.next = {
        next: null,
        event: null,
        readyState: null
      };
      if (channel) {
        channel.port2.postMessage('');
      } else {
        setTimeout(onTimeout, 0);
      }
    }

    function close() {
      // http://dev.w3.org/html5/eventsource/ The close() method must close the connection, if any; must abort any instances of the fetch algorithm started for this EventSource object; and must set the readyState attribute to CLOSED.
      if (xhr !== null) {
        xhr.onload = xhr.onerror = xhr.onprogress = xhr.onreadystatechange = empty;
        xhr.abort();
        xhr = null;
      }
      if (reconnectTimeout !== null) {
        clearTimeout(reconnectTimeout);
        reconnectTimeout = null;
      }
      if (xhrTimeout !== null) {
        clearTimeout(xhrTimeout);
        xhrTimeout = null;
      }
      that.readyState = CLOSED;
    }

    that.close = close;

    EventTarget.call(that);

    function onError() {
      //if (opened) {
        // reestablishes the connection
      queue({type: 'error'}, CONNECTING);
      //} else {
        // fail the connection
      //  queue({type: 'error'}, CLOSED);
      //}
      if (xhrTimeout !== null) {
        clearTimeout(xhrTimeout);
        xhrTimeout = null;
      }
    }

    function onXHRTimeout() {
      xhrTimeout = null;
      onProgress();
      if (wasActivity) {
        wasActivity = false;
        xhrTimeout = setTimeout(onXHRTimeout, heartbeatTimeout);
      } else {
        xhr.onload = xhr.onerror = xhr.onprogress = empty;
        xhr.abort();
        onError();
      }
    }

    function onProgress() {
      var responseText = xhr.responseText || '',
        contentType,
        i,
        j,
        part,
        field,
        value;

      if (!opened) {
        try {
          contentType = xhr.getResponseHeader ? xhr.getResponseHeader('Content-Type') : xhr.contentType;
        } catch (error) {
          // invalid state error when xhr.getResponseHeader called after xhr.abort in Chrome 18
          setTimeout(function () {
            throw error;
          }, 0);
        }
        if (contentType && (/^text\/event\-stream/i).test(contentType)) {
          queue({type: 'open'}, OPEN);
          opened = true;
          wasActivity = true;
          retry2 = retry;
        }
      }

      if (opened) {
        part = responseText.slice(charOffset);
        if (part.length > 0) {
          wasActivity = true;
        }
        console.log('responseText: ' + responseText)
        while ((i = part.search(endOfLine)) !== -1) {
          field = responseText.slice(offset, charOffset + i);
          i += part.slice(i, i + 2) === '\r\n' ? 2 : 1;
          offset = charOffset + i;
          charOffset = offset;
          part = part.slice(i);

          if (field) {
            value = '';
            j = field.indexOf(':');
            if (j !== -1) {
              value = field.slice(j + (field.slice(j + 1, j + 2) === ' ' ? 2 : 1));
              field = field.slice(0, j);
            }

            if (field === 'event') {
              eventTypeBuffer = value;
            }

            if (field === 'id') {
              lastEventIdBuffer = value; // see http://www.w3.org/Bugs/Public/show_bug.cgi?id=13761
            }

            if (field === 'retry') {
              if (/^\d+$/.test(value)) {
                retry = Number(value);
                retry2 = retry;
              }
            }

            if (field === 'heartbeatTimeout') {//!
              if (/^\d+$/.test(value)) {
                heartbeatTimeout = Number(value);
                heartbeatTimeout = heartbeatTimeout < 1 ? 1 : (heartbeatTimeout > 21600000 ? 21600000 : heartbeatTimeout);
                if (xhrTimeout !== null) {
                  clearTimeout(xhrTimeout);
                  xhrTimeout = setTimeout(onXHRTimeout, heartbeatTimeout);
                }
              }
            }

            if (field === 'data') {
              if (dataBuffer === null) {
                dataBuffer = value;
              } else {
                dataBuffer += '\n' + value;
              }
            }
          } else {
            // dispatch the event
            if (dataBuffer !== null) {
              lastEventId = lastEventIdBuffer;
              queue({
                type: eventTypeBuffer || 'message',
                lastEventId: lastEventIdBuffer,
                data: dataBuffer
              }, null);
            }
            // Set the data buffer and the event name buffer to the empty string.
            dataBuffer = null;
            eventTypeBuffer = '';
          }
        }
        charOffset = responseText.length;
      }
    }

    function onLoad() {
      onProgress();
      onError();
    }

    function onReadyStateChange() {
      if (xhr.readyState === 3) {
        onProgress();
      }
    }

    function openConnection() {
      // XDomainRequest#abort removes onprogress, onerror, onload

      xhr.onload = xhr.onerror = onLoad;

      // onprogress fires multiple times while readyState === 3
      // onprogress should be setted before calling "open" for Firefox 3.6
      xhr.onprogress = onProgress;

      // Firefox 3.6
      // onreadystatechange fires more often, than "progress" in Chrome and Firefox
      xhr.onreadystatechange = onReadyStateChange;

      reconnectTimeout = null;
      wasActivity = false;
      xhrTimeout = setTimeout(onXHRTimeout, heartbeatTimeout);

      offset = 0;
      charOffset = 0;
      opened = false;
      dataBuffer = null;
      eventTypeBuffer = '';
      lastEventIdBuffer = lastEventId;//resets to last successful

      // with GET method in FF xhr.onreadystatechange with readyState === 3 doesn't work + POST = no-cache
      xhr.open('GET', url, true);

      // withCredentials should be setted after "open" for Safari and Chrome (< 19 ?)
      xhr.withCredentials = withCredentials;

      if (xhr.setRequestHeader) { // !XDomainRequest
        // http://dvcs.w3.org/hg/cors/raw-file/tip/Overview.html
        // Cache-Control is not a simple header
        // Request header field Cache-Control is not allowed by Access-Control-Allow-Headers.
        //xhr.setRequestHeader('Cache-Control', 'no-cache');

        // Chrome bug:
        // http://code.google.com/p/chromium/issues/detail?id=71694
        // If you force Chrome to have a whitelisted content-type, either explicitly with setRequestHeader(), or implicitly by sending a FormData, then no preflight is done.
        // xhr.setRequestHeader('Content-type', 'application/x-www-form-urlencoded');
        xhr.setRequestHeader('Accept', 'text/event-stream');

        // Request header field Last-Event-ID is not allowed by Access-Control-Allow-Headers.
        // +setRequestHeader shouldn't be used to avoid preflight requests
        //if (lastEventId !== '') {
        //  xhr.setRequestHeader('Last-Event-ID', lastEventId);
        //}
      }
      xhr.send(lastEventId !== '' ? 'Last-Event-ID=' + encodeURIComponent(lastEventId) : '');
    }

    openConnection();

    return that;
  }

  proto = new EventTarget();
  proto.CONNECTING = CONNECTING;
  proto.OPEN = OPEN;
  proto.CLOSED = CLOSED;

  EventSource.prototype = proto;
  EventSource.CONNECTING = CONNECTING;
  EventSource.OPEN = OPEN;
  EventSource.CLOSED = CLOSED;
  proto = null;

  if (Transport) {
    global.EventSource2 = EventSource;
  }

}(this));

;(function () {

function sortci(a, b) {
  return a.toLowerCase() < b.toLowerCase() ? -1 : 1;
}

// from console.js
function stringify(o, simple) {
  var json = '', i, type = ({}).toString.call(o), parts = [], names = [];

  if (type == '[object String]') {
    json = '"' + o.replace(/\n/g, '\\n').replace(/"/g, '\\"') + '"';
  } else if (type == '[object Array]') {
    json = '[';
    for (i = 0; i < o.length; i++) {
      parts.push(stringify(o[i], simple));
    }
    json += parts.join(', ') + ']';
    json;
  } else if (type == '[object Object]') {
    json = '{';
    for (i in o) {
      names.push(i);
    }
    names.sort(sortci);
    for (i = 0; i < names.length; i++) {
      parts.push(stringify(names[i]) + ': ' + stringify(o[names[i] ], simple));
    }
    json += parts.join(', ') + '}';
  } else if (type == '[object Number]') {
    json = o+'';
  } else if (type == '[object Boolean]') {
    json = o ? 'true' : 'false';
  } else if (type == '[object Function]') {
    json = o.toString();
  } else if (o === null) {
    json = 'null';
  } else if (o === undefined) {
    json = 'undefined';
  } else if (simple == undefined) {
    json = type + '{\n';
    for (i in o) {
      names.push(i);
    }
    names.sort(sortci);
    for (i = 0; i < names.length; i++) {
      parts.push(names[i] + ': ' + stringify(o[names[i]], true)); // safety from max stack
    }
    json += parts.join(',\n') + '\n}';
  } else {
    try {
      json = o+''; // should look like an object
    } catch (e) {}
  }
  return json;
}

function addEvent(type, fn) {
  window.addEventListener ? window.addEventListener(type, fn, false) : window.attachEvent('on' + type, fn);
};

function error(error, cmd) {
  var msg = JSON.stringify({ response: error.message, cmd: cmd, type: 'error' });
  // if (remoteWindow) {
  //   remoteWindow.postMessage(msg, origin);
  // } else {
  //   queue.push(msg);
  // }
  console.log(JSON.stringify(error));
}

function restore() {
  var data = {},
      rawData = useSS ? sessionStorage.spike : window.name,
      scroll;

  if ((!useSS && window.name == 1) || !rawData) return;

  try {
    // sketchy I know, but doesn't rely on native json support which might be a problem in old mobiles
    eval('data = ' + rawData);

    addEvent('load', function () {
      //console.log('scrolling to', data.y);
      window.scrollTo(data.x, data.y);
    });
  } catch (e) {}
}

var htmlToSave = '', file = null;

window.reload = function() {
  console.log('getting new page: ' + id);

  var xhr = new XMLHttpRequest(); 
  xhr.open('GET', id + 'quiet', true); 
  xhr.setRequestHeader('X-Requested-With', 'XMLHttpRequest'); 
  xhr.onload = function () {
    htmlToSave = xhr.responseText;
    window.requestFileSystem(LocalFileSystem.PERSISTENT, 0, gotFS, fail);
  };
  xhr.send();
}

function gotFS(fileSystem) {
  fileSystem.root.getFile("page.html", {create: true, exclusive: false}, gotFileEntry, fail);
}

function gotFileEntry(fileEntry) {
  file = fileEntry;
  fileEntry.createWriter(gotFileWriter, fail);
}

function gotFileWriter(writer) {
  writer.onwriteend = function(evt) {
    console.log('Write complete - reloading');
    window.location = file.toURL() + '?' + Math.random(); // bust that bad boy
  };
  inject();
  writer.write(htmlToSave);
}

function fail(error) {
  console.log('Fail: ' + error.code);
}

function inject(ready) {
  // window.requestFileSystem(LocalFileSystem.PERSISTENT, 0, onFileSystemSuccess, fail);
  var root = {
    android: 'file:///android_asset/www/',
    blackberry: 'local:///',
    iphone: localStorage.getItem('jsbin-ios-root'),
    'iphone simulator': localStorage.getItem('jsbin-ios-root')
  }[device.platform.toLowerCase()] || 'file:///';
  var code = ['<head>',
              '<script src="' + root + 'cordova-2.0.0.js"></script>',
              '<script src="' + root + 'spike.js"></script>',
              '<script>runSpike();</script>'].join('\n');
  htmlToSave = htmlToSave.replace(/<head>/i, code);
}

function renderStream() {
  es.addEventListener('css', function (event) {
    var style = document.getElementById('jsbin-css');

    if (style.styleSheet) {
      style.styleSheet.cssText = event.data;
    } else {
      style.innerHTML = event.data;
    }
  });

  es.addEventListener('error', function () {
    console.log('Error on stream');
  });

  es.addEventListener('reload', reload);
}

var user = localStorage.getItem('jsbin-username'),
    jsbinroot = 'jsbin.com',
    id = 'http://' + jsbinroot + '/' + user + '/last/',
    queue = [],
    msgType = '',
    useSS = false,
    es = null,
    hasRun = false;

window.runSpike = function(e) {
  console.log('run()')
  if (hasRun) return;
  hasRun = true;
  setTimeout(function () {
    console.log('connecting to EventSource ' + id);
    es = new EventSource2(id + '?' + Math.random());
    renderStream();
  }, 500);

  addEvent('error', function (event) {
    console.log('ERROR: ' + event.message);
    error({ message: event.message }, event.filename + ':' + event.lineno);
  });
}

// document.addEventListener("deviceready", run, false);

}());

console.log('Loaded spike.js')

