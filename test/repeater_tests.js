var net        = require('net'),
    spawn      = require('child_process').spawn,
    fs         = require('fs'),
    temp       = require('temp'),
    dgram      = require('dgram');


var writeconfig = function(text) {
  var info = temp.openSync({ suffix: '-statsdconf.js' });
  fs.writeSync(info.fd, text);
  return info.path;
};


function log() {
  //console.log.apply(console, arguments);
}


var FakeStatsDServer = function() {
  this.port = 9125;
};

FakeStatsDServer.prototype.start = function(cb) {
  this.sock = dgram.createSocket('udp4');

  var self = this;
  this.sock.on('listening', function() {
    log('Fake statsd server listening on', self.port);
    cb();
  });

  this.sock.bind(this.port);
};

FakeStatsDServer.prototype.stop = function(cb) {
  this.sock.close();
  cb();
};

FakeStatsDServer.prototype.collect = function(timeout, cb) {
  var sock = this.sock;

  var messages = [];
  function onmsg(msg) {
    log('Received %s', msg.toString());
    messages.push(msg.toString());
  }

  sock.on('message', onmsg);

  setTimeout(function() {
    sock.removeListener('message', onmsg);
    cb(messages);
  }, timeout);
};


var StatsDClient = function(port, host) {
  this.host = host || '127.0.0.1';
  this.port = port || 8125;
};

StatsDClient.prototype.send = function(data, cb) {
  var buf = new Buffer(data);
  var sock = dgram.createSocket('udp4');
  sock.send(buf, 0, buf.length, this.port, this.host, function(err, bytes) {
    if(err) {
      throw err;
    }
    sock.close();
    cb();
  });
};


var RepeaterServer = function(port, server_port) {
  this.port = port || 8125;
  this.server_port = server_port || 9125;
  this.config = {
    repeater: [{ host: '127.0.0.1', port: this.server_port }],
    repeaterProtocol: 'udp4',
    server: './servers/udp',
    port: this.port,
    backends: [ './backends/repeater' ]
  };
};

RepeaterServer.prototype.start = function(cb) {
  var config_path = writeconfig(JSON.stringify(this.config));
  log('Wrote config file %s', config_path);
  log('Starting repeater listening on', this.port, 
      'forwarding to', this.server_port);
  
  this.server_up = true;
  this.ok_to_die = false;
  var self = this;
  var r = spawn('node', ['stats.js', config_path]);

  r.on('exit', function(code) {
    self.server_up = false;
    if(!self.ok_to_die) {
      console.log('node server unexpectedly quit with code:', code);
      process.exit();
    }
    self.exit_callback();
  });
  
  r.stderr.on('data', function(data) {
    console.log('stderr: ' + data.toString().replace(/\n$/,''));
  });

  r.stdout.on('data', function (data) {
    if (data.toString().match(/server is listening/)) {
      log('Repeater server is up');
      cb();
    }
  });

  this.repeater = r;
};

RepeaterServer.prototype.stop = function(cb) {
  this.ok_to_die = true;
  if(this.server_up) {
    this.exit_callback = cb;
    this.repeater.kill();
  } else {
    cb();
  }
};


var ServerSet = function() {
  this.servers = [];
};
ServerSet.prototype.add = function() { 
  for(var i = 0; i < arguments.length; i++) {
    this.servers.push(arguments[i]);
  }
};
ServerSet.prototype.start = function(cb) {
  var self = this;
  function start_server(i) {
    if(i == self.servers.length) {
      cb();
    } else {
      self.servers[i].start(function() {
        start_server(i + 1);
      });
    }
  }
  start_server(0);
};
ServerSet.prototype.stop = function(cb) {
  var self = this;
  function stop_server(i) {
    if(i == self.servers.length) {
      cb();
    } else {
      self.servers[i].stop(function() {
        stop_server(i + 1);
      });
    }
  }
  stop_server(0);
};



module.exports = {

  setUp: function(cb) {
    this.servers = new ServerSet();
    this.repeater = new RepeaterServer();
    this.servers.add(this.repeater);
    cb();
  },

  tearDown: function(cb) {
    this.servers.stop(cb);
  },


  repeater_works: function(test) {
    test.expect(1);
    var statsd = new FakeStatsDServer();
    this.servers.add(statsd);
    var client = new StatsDClient(this.repeater.port, '127.0.0.1');

    this.servers.start(function(){ 
      client.send('foobar', function() {
        statsd.collect(100, function(messages) {
          test.equal(messages[0], 'foobar');
          test.done();
        });
      });
    });
  }

};