var common = require('./common');
var createRedisClient = common.createRedisClient;
var extend = common.extend;
var redis = require('redis');
var Shavaluator = require('redis-evalsha');
var util = require('util');
var EventEmitter = require('events').EventEmitter;
var makeUuid = require('uuid').v4;
var cpuCount = require('os').cpus().length;
var Pend = require('pend');
var path = require('path');
var JobWorker = require('./worker');
var spawn = require('child_process').spawn;

module.exports = JobQueue;

var childModulePath = path.join(__dirname, "child.js");
var shavaluator = new Shavaluator();

shavaluator.add('moveAll',
    'while redis.call("rpoplpush",KEYS[1],KEYS[2]) do\n' +
    'end\n' +
    'return nil\n');

var queueDefaults = {
  namespace: "redis-dist-job-queue.",
  queueId: "default",
  redisConfig: {},
  workerCount: cpuCount,
  childProcessCount: 0,
};

var redisConfigDefaults = {
  port: 6379,
  host: "127.0.0.1",
  db: 1,
};

util.inherits(JobQueue, EventEmitter);
function JobQueue(options) {
  EventEmitter.call(this);

  options = extend(extend({}, queueDefaults), options || {});
  this.namespace = options.namespace;
  this.queueId = options.queueId;

  this.queueKey = this.namespace + "queue." + this.queueId;
  this.processingQueueKey = this.namespace + "queue_processing." + this.queueId;
  this.workerCount = options.workerCount;
  this.childProcessCount = options.childProcessCount;
  this.redisConfig = extend(extend({}, redisConfigDefaults), options.redisConfig);
  this.modulePaths = [];
  this.redisClient = createRedisClient(this.redisConfig);
  this.childProcesses = [];
  this.childWorker = null;
}

JobQueue.prototype.start = function() {
  this.shuttingDown = false;
  if (this.childProcessCount > 0) {
    this.startChildProcesses();
  } else {
    this.startWorkers();
  }
};

JobQueue.prototype.startChildProcesses = function() {
  var self = this;
  var args = [
    childModulePath,
    JSON.stringify(self.serializeOptions()),
  ];
  var opts = {
    stdio: [process.stdin, process.stdout, process.stderr, 'ipc'],
  };
  for (var i = 0; i < self.childProcessCount; i += 1) {
    createChild();
  }

  function createChild() {
    var child = spawn(process.execPath, args, opts);
    self.childProcesses.push(child);
    child.on('exit', createOnExit(child));
    child.on('message', onMessage);
  }

  function createOnExit(child) {
    return function() {
      var index = self.childProcesses.indexOf(child);
      if (index >= 0) self.childProcesses.splice(index, 1);
      if (self.shuttingDown) return;
      createChild();
    };
  }

  function onMessage(json) {
    if (self.shuttingDown) return;

    var msg = JSON.parse(json);
    if (msg.type === 'error') {
      self.emit('error', msg.value);
    } else {
      throw new Error("unrecognized message type: " + msg.type);
    }
  }
};

JobQueue.prototype.serializeOptions = function() {
  return {
    namespace: this.namespace,
    queueId: this.queueId,
    workerCount: this.workerCount,
    redisConfig: this.redisConfig,
    modulePaths: this.modulePaths,
  };
};

JobQueue.prototype.startWorkers = function() {
  var self = this;
  self.childWorker = new JobWorker(self.serializeOptions());
  self.childWorker.on('error', function(err) {
    self.emit('error', err);
  });
  self.childWorker.start();
};

JobQueue.prototype.registerTask = function(modulePath) {
  var dirname = path.dirname(module.parent.filename);
  var modulePathAbs = require.resolve(path.join(dirname, modulePath));
  this.modulePaths.push(modulePathAbs);
};

// begin a process job. If the resource is already ongoing processing,
// nothing happens.
JobQueue.prototype.submitJob = function(taskId, resourceId, params, cb) {
  var json = JSON.stringify({
    type: taskId,
    resource: resourceId,
    params: params,
  });
  this.redisClient.send_command('lpush', [this.queueKey, json], function(err, result) {
    cb(err);
  });
};

JobQueue.prototype.shutdown = function(callback) {
  var self = this;

  self.shuttingDown = true;

  var pend = new Pend();
  pend.go(function(cb) {
    self.redisClient.quit(function(err, result) {
      if (err) {
        self.emit('error', err);
      }
      cb();
    });
  });
  self.childProcesses.forEach(function(child) {
    pend.go(function(cb) {
      child.on('exit', cb);
      child.send('shutdown');
    });
  });
  if (self.childWorker) {
    pend.go(shutdownChildWorker);
  }
  pend.wait(callback);

  function shutdownChildWorker(cb) {
    self.childWorker.shutdown(cb);
  }
};