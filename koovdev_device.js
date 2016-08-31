/* -*- indent-tabs-mode: nil; js-indent-level: 2 -*-
 */

'use strict';
const debug = require('debug')('koovdev_device');

/*
 * Device management
 */

const BLE_OPTS = {
  BTS01: {
    service_id: '55df0001a9b011e3a5e2000190f08f1e',
    characteristic_tx: '55df0002a9b011e3a5e2000190f08f1e',
    characteristic_rx: '55df0003a9b011e3a5e2000190f08f1e'
  },
  BTS01_GPIO: {
    service_id: '55df0001a9b011e3a5e2000190f08f1e',
    characteristic_tx: '55df8001a9b011e3a5e2000190f08f1e',
    characteristic_rx: '55df8001a9b011e3a5e2000190f08f1e'
  }
};

const KoovBle = (() => {
  if (process.platform === 'win32') {
    return null;
  }
  const noble_device = require('noble-device');
  let ble = function(peripheral) {
    noble_device.call(this, peripheral);
  };
  ble.SCAN_UUIDS = [BLE_OPTS.BTS01.service_id];
  noble_device.Util.inherits(ble, noble_device);
  ble.prototype.writeGPIO = function(data, done) {
    this.writeDataCharacteristic(BLE_OPTS.BTS01_GPIO.service_id,
                                 BLE_OPTS.BTS01_GPIO.characteristic_tx,
                                 data, done);
  };
  ble.prototype.readGPIO = function(done) {
    this.readDataCharacteristic(BLE_OPTS.BTS01_GPIO.service_id,
                                BLE_OPTS.BTS01_GPIO.characteristic_rx,
                                done);
  };
  ble.prototype.write = function(data, done) {
    this.writeDataCharacteristic(BLE_OPTS.BTS01.service_id,
                                 BLE_OPTS.BTS01.characteristic_tx,
                                 data, done);
  };
  ble.prototype.read = function(done) {
    this.notifyCharacteristic(BLE_OPTS.BTS01.service_id,
                              BLE_OPTS.BTS01.characteristic_rx,
                              true, done, function(err) {
                                debug('notify callback', err);
                              });
  };
  return ble;
})();

function Device_BTS01(opts)
{
  this.id = device_id();
  this.type = 'ble';
  this.name = opts.name;
  this.friendly_name = opts.name + ' (' + opts.periph.address + ')';
  this.dev = opts.dev;
  this.periph = opts.periph;
  this.board = null;
  this.action = null;
  this.listeners = [];
  this.write_callback = null;

  const ble_opts = BLE_OPTS.BTS01;
  const done = (err) => {
    if (this.write_callback) {
      const callback = this.write_callback;
      this.write_callback = null;
      return callback(err);
    }
  };
  const cleanup = () => {
    this.serial = null;
    this.listeners.forEach(l => {
      this.dev.removeListener(l.name, l.handler);
    });
    this.listeners = [];
  };
  this.open_device = (cb) => {
    debug('open ble');
    if (this.serial) {
      debug('open ble: already open');
      return cb(null);
    }
    this.serial = {
      close: (cb) => {
        this.dev.disconnect(cb);
      },
      write: (data, cb) => {
        //debug('writing', data);
        this.dev.write(data, (err) => {
          //debug('write done', err, data);
          if (cb)
            cb(err);
        });
      },
      on: (type, cb) => {
        debug('ble.on', type);
        if (type === 'close' || type === 'disconnect') {
          let handler = () => {
            debug('disconnected');
            cleanup();
            done({ msg: 'write failure: disconnected' });
            cb();
          };
          this.dev.on('disconnect', handler);
          this.listeners.push({ name: 'disconnect', handler: handler });
          return;
        }
        if (type === 'data') {
          this.dev.read(cb);
          this.listeners.push({ name: 'data', handler: cb });
          return;
        }
        debug(`on: NOT SUPPPORTED TYPE: ${type}`);
      }
    };
    this.dev.connectAndSetUp((err) => {
      debug(`connectAndSetUp: ${err}`);
      return cb(err);
    });
  };
  this.open = (cb) => {
    this.open_device((err) => {
      return cb(err);
    });
  };
  this.close = (cb) => {
    debug('close: ble');
    if (this.serial) {
      const serial = this.serial;
      cleanup();
      serial.close((err) => { cb(err); });
    } else {
      return cb(null);
    }
  };
  const reset_koov = (cb) => {
    this.open_device((err) => {
      debug('reset_koov', err);
      if (err)
        return cb(err);
      this.dev.on('disconnect', () => {
        debug('reset_koov: ignore disconnected');
      });
      this.dev.writeGPIO(new Buffer([1, 0]), (err) => {
        debug('reset_koov: write 1, 0', err);
        setTimeout(() => {
          this.dev.writeGPIO(new Buffer([1, 2]), (err) => {
            debug('reset_koov: write 1, 2', err);
          });
          setTimeout(() => {
            this.close((err) => {
              debug('reset_koov: close', err);
              return cb(err);
            });
          }, 100);
        }, 10);
      });
    });
  };
  this.reset_koov = reset_koov;
  this.serial_write = function(data, cb) {
    //debug('ble.write:', data);
    this.write_callback = cb;
    if (!this.serial)
      return done({ msg: 'no serial device' });
    /*
     * Write with dividing into 20 byte chunks.
     */
    const write20 = (data, callback) => {
      let length = data.length;
      if (length > 20)
        length = 20;
      this.serial.write(data.slice(0, length), err => {
        data = data.slice(length);
        if (!err && data.length > 0)
          return write20(data, callback);
        return callback(err);
      });
    };
    return write20(data, done);
  };
  this.on = function(what, cb) {
    debug(`ble.on ${what}:`, cb);
    if (!this.serial)
      return cb({ msg: 'no serial device' });
    this.serial.on(what, cb);
  };
  this.program_sketch = (buffer, callback, progress) => {
    debug('program_sketch');
    this.close((err) => {
      debug('program_sketch: close', err);
      if (err)
        return callback(err);
      this.reset_koov((err) => {
        debug('program_sketch: reset', err);
        if (err)
          return callback(err);
        const stk500v2 = require('avrgirl-stk500v2');
        debug(`stk500v2: ${this.name}`);
        /*
         * Write with dividing into 20 byte chunks.
         */
        const ble_write = (data, callback) => {
          let length = data.length;
          if (length > 20)
            length = 20;
          debug('write!', data);
          this.serial.write(data.slice(0, length), err => {
            data = data.slice(length);
            debug('write! complete', data);
            if (data.length > 0)
              return ble_write(data, callback);
            else {
              debug('write done!');
              callback();
            }
          });
        };
        /*
         * ble serial wrapper for stk500v2 module.
         */
        let bleWrap = {
          path: 'dummy',        // this is necessary.
          open: (callback) => { this.open_device(callback); },
          on: (what, callback) => { this.serial.on(what, callback); },
          close: (callback) => { this.close(callback); },
          write: ble_write,
          drain: (callback) => { debug('drain called'); callback(null); },
        };
        const options = {
          comm: bleWrap,
          chip: atmega2560,
          frameless: false,
          debug: true
        };
        const stk = new stk500v2(options);
        program_sketch(stk, buffer, (err) => {
          this.close((close_err) => {
            callback(err || close_err);
          });
        }, progress);
      });
    });
  };
}

function scan_ble(cb, timeout) {
  if (process.platform == 'win32') {
    cb('ble', null, []);
    return;
  }

  debug('scan ble', timeout);

  let found = [];
  const discoverCallback = dev => {
    debug('discoverAll', dev);
    const name = dev._peripheral.advertisement.localName;
    if (!found.find(x => { return x.dev.id === dev.id; }))
      found.push({ name: name, dev: dev, periph: dev._peripheral });
  };
  KoovBle.discoverAll(discoverCallback);

  setTimeout(() => {
    KoovBle.stopDiscoverAll(discoverCallback);
    cb('ble', null, found.map(x => { return new Device_BTS01(x); }));
  }, timeout);
}

/*
 * Predicate for normal koov device file.
 */
const is_koovdev = x => {
  debug(`is_koovdev`, x);
  return x.vendorId === '0x054c' && x.productId === '0x0be6' ||
    (x.pnpId && x.pnpId.match(/VID_054C&PID_0BE6/));
};

/*
 * Predicate for koov device file under bootloader mode.
 */
const is_bootdev = x => {
  debug(`is_bootdev`, x);
  return x.vendorId === '0x054c' && x.productId === '0x0bdc' ||
    (x.pnpId && x.pnpId.match(/VID_054C&PID_0BDC/));
};

const device_id = (() => {
  let id = 0;
  return () => { return id++; };
})();

function Device_USB(opts)
{
  this.id = device_id();
  this.type = 'usb';
  this.name = opts.name;
  this.dev = opts.dev;
  this.board = null;
  this.action = null;
  this.serial = null;
  this.listeners = [];

  const cleanup = () => {
    this.listeners.forEach(l => {
      this.serial.removeListener(l.name, l.handler);
    });
    this.listeners = [];
    this.serial = null;
  };
  this.open_device = (cb) => {
    const serialport = require('serialport');
    debug(`open_device: ${this.name}`);
    const sp = new serialport.SerialPort(this.name, {
      baudrate: 115200,
      parser: serialport.parsers.raw
    }, false);
    this.serial = sp;
    const handler = (err) => {
      debug(`stk500v2: ${this.name}: disconnected`, err);
      return cb(err);
    };
    sp.on('disconnect', handler);
    this.listeners.push({ name: 'disconnect', handler: handler });
    sp.open((err) => {
      debug(`open_device: ${this.name}:`, err);
      return cb(err);
    });
  };
  this.open = function(cb) {
    debug('usb open');
    if (is_bootdev(this.dev))
      return cb('cannot open in bootloader mode');
    var serialport = require('serialport');
    /*
     * Settings copied from firmata.js.  The value of baudrate doesn't
     * matter actually, since there is no serial port between host and
     * target M0/M0 pro.
     */
    var serial_settings = { baudRate: 57600, bufferSize: 1 };
    var serial = new serialport.SerialPort(this.name, serial_settings, false);
    this.serial = serial;
    serial.open((err) => {
      debug('serial open', err);
      return cb(err);
    });
  };
  this.close = function(cb) {
    debug('close: usb');
    if (this.serial) {
      const serial = this.serial;
      cleanup();
      serial.close(() => { cb(null); });
    } else
      cb(null);
  };
  const touch1200 = (cb) => {
    const serialport = require('serialport');
    /*
     * Open device with 1200 baud and close to put device into
     * bootloader.
     */
    const openclose = (cb) => {
      const sp = new serialport.SerialPort(this.name, {
        baudRate: 1200
      }, false);
      sp.open((err) => {
        debug('touch1200: open', err);
        if (err && !err.message.match(/error code 31/))
          return cb(err);
        sp.close(cb);
      });
    };
    /*
     * List seriali device file and find bootloader in it.
     */
    const find_bootloader = (cont) => {
      serialport.list((err, ports) => {
        if (err) return cb(err);
        const port = ports.find(is_bootdev);
        if (port) {
          let name = port.comName;
          debug(`switch device from ${this.name} to ${name}`);
          this.name = name;
          return cb(null);
        }
        return cont();
      });
    };
    const times = (count, timeout, cb) => {
      const cont = () => { setTimeout(() => { cb(--count, cont); }, timeout); };
      return cont();
    };
    find_bootloader(() => {
      openclose(err => {
        times(50, 100, (count, cont) => {
          find_bootloader(() => {
            if (count <= 0)
              return cb('no bootloader device found');
	    cont();
	  });
        });
      });
    });
  };
  this.serial_write = function(data, cb) {
    this.serial.write(data, cb);
  };
  this.on = function(what, cb) {
    debug('usb.on ${what}:', cb);
    this.listeners.push({ name: what, handler: cb });
    this.serial.on(what, cb);
  };
  this.reset_koov = touch1200;
  this.program_sketch = (buffer, callback, progress) => {
    debug('program_sketch');
    this.close((err) => {
      debug('program_sketch: close', err);
      if (err)
        return callback(err);
      this.reset_koov((err) => {
        debug('program_sketch: reset', err);
        if (err)
          return callback(err);
        const stk500v2 = require('avrgirl-stk500v2');
        debug(`stk500v2: ${this.name}`);
        const serialport = require('serialport');
        const sp = new serialport.SerialPort(this.name, {
          baudrate: 115200,
          parser: serialport.parsers.raw
        }, false);
        sp.on('disconnect', (err) => {
          debug(`stk500v2: ${this.name}: disconnected`, err);
          callback(err);
        });
        const options = {
          comm: sp,
          chip: atmega2560,
          frameless: false,
          debug: false
        };
        const stk = new stk500v2(options);
        program_sketch(stk, buffer, (err) => {
          debug(`stk500v2: ${this.name}: program_sketch`, err);
          sp.close((close_err) => {
            callback(err || close_err);
          });
        }, progress);
      });
    });
  };
}

function scan_usb(cb, timeout)
{
  var sp = require('serialport');
  debug('scan usb');
  sp.list((err, ports) => {
    var devs = ports.reduce((acc, x) => {
      debug('scan found', x);
      const found = [
        /^.dev.(tty|cu).usb.*/,
        //spaces between '1,' and '3' caused unexpected result.
        /COM[0-9]{1,3}/
      ].some(re => {
        return x.comName.match(re) &&
          (is_koovdev(x) || is_bootdev(x));
      });
      if (found)
        acc.push(new Device_USB({ name: x.comName, dev: x }));
      return acc;
    }, []);

    cb('usb', err, devs);
  });
}

function Device()
{
  this.candidates = [];
  this.device = null;
  this.list = function() {
    return this.candidates.map(x => {
      let v = { id: x.id, type: x.type, name: x.name };
      if (x.type === 'ble') {
        v.address = x.periph.address;
        v.uuid = x.periph.uuid;
      }
      if (x.type === 'usb') {
        v.mode = is_bootdev(x.dev) ? 'bootloader' : 'firmata';
      }
      return v;
    });
  };

  (() => {
    var complete = [
      { type: 'ble', done: false, error: null, result: [] },
      { type: 'usb', done: false, error: null, result: [] }
    ];
    this.start_scan = function(cb, timeout) {
      if (!timeout)
        timeout = 1000;
      var callback = (type, err, result) => {
        var x = complete.find(x => { return x.type === type; });

        x.error = err;
        x.result = result;
        x.done = true;
        if (complete.every(x => { return x.done; })) {
          var e = complete.reduce((acc, x) => {
            return acc || x.error; }, null);
          var r = complete.reduce((acc, x) => {
            return acc.concat(x.result); }, []);

          this.candidates = r;
          cb(e);
        }
      };

      complete.forEach(x => {
        x.done = false;
        x.error = null;
        x.result = [];
      });
      scan_ble(callback, timeout);
      scan_usb(callback, timeout);
    };
    this.stop_scan = function() {
    };
  })();
  const find_device = (obj, callback) => {
    let id = '?';
    debug('find_device', obj);
    if (typeof obj === 'object') {
      this.device = this.candidates.find(x => x.id === obj.id);
      id = `id: ${obj.id}`;
    } else {
      const name = obj;
      this.device = this.candidates.find(x => {
        return x.friendly_name === name || x.name === name;
      });
      id = `name: ${name}`;
    }
    if (!this.device) {
      callback({msg: `no such device: ${id}`});
      return false;
    }
    return true;
  };
  this.find_device = (obj, cb) => {
    if (find_device(obj, cb))
      return cb(null);
  }
  this.open = function(name, cb, err) {
    const open = (err) => {
      if (err)
        return cb(err);
      if (find_device(name, cb))
        this.device.open(cb);
    };
    this.close(open);
  };
  this.close = function(cb) {
    if (this.device) {
      const device = this.device;
      this.device = null;
      device.close(cb);
    } else
      cb(null);
  };
  this.serial_open = function(cb) {
    if (!this.device)
      return cb('device is not found');
    this.device.open_device(cb);
  };
  this.serial_write = function(data, cb) {
    if (!this.device)
      return cb('device is not found');
    this.device.serial_write(data, (err) => {
      //debug('device.serial_write: done', err, data);
      cb(err);
    });
  };
  this.serial_event = function(what, cb, notify) {
    if (!this.device)
      return cb('device is not open');
    this.device.on(what.substring('serial-event:'.length), (arg) => {
      debug(`${what}:`, arg);
      notify(arg);
    });
    cb(null);
  };
  this.reset_koov = function(cb) {
    if (!this.device)
      return cb('device is not open');
    return this.device.reset_koov(cb);
  };
  this.action = function() {
    return this.device ? this.device.action : null;
  };
  this.program_sketch = (name, sketch, callback, progress) => {
    const intelhex = require('intel-hex');
    const buffer = intelhex.parse(sketch).data;
    this.close(err => {
      if (err)
        return callback(err);
      if (find_device(name, callback))
        this.device.program_sketch(buffer, callback, progress);
    });
  };
};

let device = new Device();
module.exports = {
  device: function() {
    return device;
  }
};
