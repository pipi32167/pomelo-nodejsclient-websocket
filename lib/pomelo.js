/* global WebSocket: true */
'use strict';
var _ = require('underscore');
var WebSocket = require('ws');
var assert = require('assert');
var util = require('util');
var crypto = require('crypto');
var Protocol = require('pomelo-protocol');
var Package = Protocol.Package;
var Message = Protocol.Message;
var protobuf = require('pomelo-protobuf');
var EventEmitter = require('events').EventEmitter;

var JS_WS_CLIENT_TYPE = 'js-websocket';
var JS_WS_CLIENT_VERSION = '0.0.1';

var RES_OK = 200;
var RES_OLD_CLIENT = 501;

var defaultLogger = {
  debug: console.log,
  info: console.log,
  warn: console.warn,
  error: console.error,
  trace: console.trace,
}

var Pomelo = function(opts) {
  EventEmitter.call(this);
  opts = opts || {};
  this.logger = opts.logger || defaultLogger;
  this.isInit = false;
  this.socket = null;
  this.reqId = 0;
  this.callbacks = {};
  this.handlers = {};
  this.routeMap = {};

  this.heartbeatInterval = 10000;
  this.heartbeatTimeout = this.heartbeatInterval * 2;
  this.nextHeartbeatTimeout = 0;
  this.gapThreshold = 100; // heartbeat gap threshold
  this.heartbeatId = null;
  this.heartbeatTimeoutId = null;

  this.handshakeCallback = null;

  this.initCallback = null;

  this.handshakeBuffer = {
    'sys': {
      type: JS_WS_CLIENT_TYPE,
      version: JS_WS_CLIENT_VERSION
    },
    'user': {}
  };
  this.handlers[Package.TYPE_HANDSHAKE] = this.handshake.bind(this);
  this.handlers[Package.TYPE_HEARTBEAT] = this.heartbeat.bind(this);
  this.handlers[Package.TYPE_DATA] = this.onData.bind(this);
  this.handlers[Package.TYPE_KICK] = this.onKick.bind(this);
}

util.inherits(Pomelo, EventEmitter);

Pomelo.prototype.init = function(params, cb) {
  this.isInit = true;
  this.params = params;
  params.debug = true;
  this.initCallback = cb;
  var host = params.host;
  var port = params.port;

  var url = 'ws://' + host;
  if (port) {
    url += ':' + port;
  }

  if (!params.type) {
    this.logger.debug('init websocket');
    this.handshakeBuffer.user = params.user;
    this.handshakeCallback = params.handshakeCallback;
    this.initWebSocket(url, cb);
  }
};

Pomelo.prototype.initWebSocket = function(url, cb) {
  this.logger.debug(url);
  var self = this;
  var onopen = function(event) {
    self.logger.debug('[pomeloclient.init] websocket connected!');
    var obj = Package.encode(Package.TYPE_HANDSHAKE, Protocol.strencode(JSON.stringify(self.handshakeBuffer)));
    self.send(obj);
  };
  var onmessage = function(event) {
    self.processPackage(Package.decode(event.data), cb);
    // new package arrived, update the heartbeat timeout
    if (self.heartbeatTimeout) {
      self.nextHeartbeatTimeout = Date.now() + self.heartbeatTimeout;
    }
  };
  var onerror = function(event) {
    self.emit('io-error', event);
    self.logger.error('socket error %j ', event);
  };
  var onclose = function(event) {
    self.emit('close', event);
    self.logger.info('socket close %d ', event.code);
  };
  this.socket = new WebSocket(url);
  this.socket.binaryType = 'arraybuffer';
  this.socket.onopen = onopen;
  this.socket.onmessage = onmessage;
  this.socket.onerror = onerror;
  this.socket.onclose = onclose;
};

Pomelo.prototype.disconnect = function() {
  this.isInit = false;
  if (this.socket) {
    if (this.socket.disconnect) this.socket.disconnect();
    if (this.socket.close) this.socket.close();
    this.logger.debug('disconnect');
    this.socket = null;
  }

  if (this.heartbeatId) {
    clearTimeout(this.heartbeatId);
    this.heartbeatId = null;
  }
  if (this.heartbeatTimeoutId) {
    clearTimeout(this.heartbeatTimeoutId);
    this.heartbeatTimeoutId = null;
  }
};

Pomelo.prototype.request = function(route, msg, cb) {
  var userId = this.user && this.user.userid ? this.user.userid : '';
  msg = msg || {};
  // this.logger.info(this.id, 'request:', route, JSON.stringify(msg));
  route = route || msg.route;
  if (!route) {
    this.logger.debug('fail to send request without route.');
    return;
  }

  this.reqId++;
  var self = this;

  self.sendMessage(self.reqId, route, msg);
  self.callbacks[self.reqId] = cb;
  self.routeMap[self.reqId] = route;
};

Pomelo.prototype.notify = function(route, msg) {
  msg = msg || {};
  this.sendMessage(0, route, msg);
};

Pomelo.prototype.sendMessage = function(reqId, route, msg) {
  var type = reqId ? Message.TYPE_REQUEST : Message.TYPE_NOTIFY;

  // this.logger.debug('sendMessage:', msg);
  //compress message by protobuf
  var protos = !!this.data.protos ? this.data.protos.client : {};
  if (!!protos[route]) {
    msg = protobuf.encode(route, msg);
  } else {
    msg = Protocol.strencode(JSON.stringify(msg));
  }

  var compressRoute = 0;
  if (this.dict && this.dict[route]) {
    route = this.dict[route];
    compressRoute = 1;
  }

  msg = Message.encode(reqId, type, compressRoute, route, msg);
  var packet = Package.encode(Package.TYPE_DATA, msg);
  this.send(packet);
};

Pomelo.prototype.send = function(packet) {
  if (!!this.socket) {
    this.socket.send(packet, {
      binary: true,
      mask: true
    });
  }
};

Pomelo.prototype.heartbeat = function(data) {
  var obj = Package.encode(Package.TYPE_HEARTBEAT);
  if (this.heartbeatTimeoutId) {
    clearTimeout(this.heartbeatTimeoutId);
    this.heartbeatTimeoutId = null;
  }

  if (this.heartbeatId) {
    // already in a heartbeat interval
    return;
  }

  var self = this;
  this.heartbeatId = setTimeout(function() {
    self.heartbeatId = null;
    self.send(obj);

    self.nextHeartbeatTimeout = Date.now() + self.heartbeatTimeout;
    self.heartbeatTimeoutId = setTimeout(self.heartbeatTimeoutCb.bind(self), self.heartbeatTimeout);
  }, self.heartbeatInterval);
};

Pomelo.prototype.heartbeatTimeoutCb = function() {
  var gap = this.nextHeartbeatTimeout - Date.now();
  if (gap > this.gapThreshold) {
    this.heartbeatTimeoutId = setTimeout(this.heartbeatTimeoutCb.bind(this), gap);
  } else {
    this.logger.error('server heartbeat timeout:', this.id);
    this.emit('heartbeat timeout');
    this.disconnect();
  }
};

Pomelo.prototype.handshake = function(data) {
  data = JSON.parse(Protocol.strdecode(data));
  if (data.code === RES_OLD_CLIENT) {
    this.emit('error', 'client version not fullfill');
    return;
  }

  if (data.code !== RES_OK) {
    this.emit('error', 'handshake fail');
    return;
  }

  this.handshakeInit(data);

  var obj = Package.encode(Package.TYPE_HANDSHAKE_ACK);
  this.send(obj);
  if (this.initCallback) {
    this.initCallback(null, this.socket);
    this.initCallback = null;
  }
};

Pomelo.prototype.onData = function(data) {
  //probuff decode
  var msg = Message.decode(data);

  if (msg.id > 0) {
    msg.route = this.routeMap[msg.id];
    delete this.routeMap[msg.id];
    if (!msg.route) {
      return;
    }
  }

  msg.body = this.deCompose(msg);

  this.processMessage(msg);
};

Pomelo.prototype.onKick = function(data) {
  this.emit('onKick');
};

Pomelo.prototype.processPackage = function(msg) {
  this.handlers[msg.type](msg.body);
};

Pomelo.prototype.processMessage = function(msg) {
  if (!msg || !msg.id) {
    // server push message
    // this.logger.error('processMessage error!!!');
    this.logger.debug(msg.route, msg.body);
    this.emit(msg.route, msg.body);
    return;
  }

  //if have a id then find the callback function with the request
  var cb = this.callbacks[msg.id];

  delete this.callbacks[msg.id];
  if (typeof cb !== 'function') {
    return;
  }
  cb(null, msg.body);
  return;
};

Pomelo.prototype.processMessageBatch = function(msgs) {
  for (var i = 0, l = msgs.length; i < l; i++) {
    this.processMessage(msgs[i]);
  }
};

Pomelo.prototype.deCompose = function(msg) {
  var protos = !!this.data.protos ? this.data.protos.server : {};
  var abbrs = this.data.abbrs;
  var route = msg.route;

  try {
    //Decompose route from dict
    if (msg.compressRoute) {
      if (!abbrs[route]) {
        this.logger.error('illegal msg!');
        return {};
      }

      route = msg.route = abbrs[route];
    }
    if (!!protos[route]) {
      return protobuf.decode(route, msg.body);
    } else {
      return JSON.parse(Protocol.strdecode(msg.body));
    }
  } catch (ex) {
    this.logger.error('route, body = ' + route + ', ' + msg.body);
  }

  return msg;
};

Pomelo.prototype.handshakeInit = function(data) {
  if (data.sys && data.sys.heartbeat) {
    this.heartbeatInterval = data.sys.heartbeat * 1000; // heartbeat interval
    this.heartbeatTimeout = this.heartbeatInterval * 2; // max heartbeat timeout
  } else {
    this.heartbeatInterval = 0;
    this.heartbeatTimeout = 0;
  }

  this.initData(data);

  if (typeof handshakeCallback === 'function') {
    this.handshakeCallback(data.user);
  }
};

//Initilize data used in pomelo client
Pomelo.prototype.initData = function(data) {
  if (!data || !data.sys) {
    return;
  }
  this.data = this.data || {};
  var dict = data.sys.dict;
  var protos = data.sys.protos;

  //Init compress dict
  if (!!dict) {
    this.data.dict = dict;
    this.data.abbrs = {};

    for (var route in dict) {
      this.data.abbrs[dict[route]] = route;
    }
  }

  //Init protobuf protos
  if (!!protos) {
    this.data.protos = {
      server: protos.server || {},
      client: protos.client || {}
    };
    if (!!protobuf) {
      protobuf.init({
        encoderProtos: protos.client,
        decoderProtos: protos.server
      });
    }
  }
};

module.exports = Pomelo;