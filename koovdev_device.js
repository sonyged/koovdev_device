/* -*- indent-tabs-mode: nil; js-indent-level: 2 -*-
 *
 * Copyright (c) 2017 Sony Global Education, Inc.
 *
 * Permission is hereby granted, free of charge, to any person
 * obtaining a copy of this software and associated documentation
 * files (the "Software"), to deal in the Software without
 * restriction, including without limitation the rights to use, copy,
 * modify, merge, publish, distribute, sublicense, and/or sell copies
 * of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be
 * included in all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
 * EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
 * MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
 * NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS
 * BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN
 * ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
 * CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

'use strict';
var debug = require('debug')('koovdev_device');
const koovdev_error = require('koovdev_error');

/*
 * Device management
 */

const KOOVDEV_DEVICE_ERROR = 0xfe;

const DEVICE_NO_ERROR = 0x00;
const DEVICE_UNKNOWN_DEVICE = 0x01;
const DEVICE_NO_DEVICE = 0x02;

const BLE_NO_ERROR = 0x10;
const BLE_WRITE_ERROR = 0x11;
const BLE_DISCONNECT_ERROR = 0x12;
const BLE_CONNECT_ERROR = 0x13;
const BLE_GPIO_ERROR = 0x14;
const BLE_NO_DEVICE = 0x15;
const BLE_DEVICE_NOT_PAIRED = 0x16;

const USB_NO_ERROR = 0x20;
const USB_OPEN_ERROR = 0x21;
const USB_CLOSE_ERROR = 0x22;
const USB_LIST_ERROR = 0x23;
const USB_NO_BOOTLOADER = 0x24;
const USB_WRITE_ERROR = 0x25;
const USB_UNEXPECTED_BOOTLOADER = 0x26;

const { error, error_p, make_error } = koovdev_error(KOOVDEV_DEVICE_ERROR, [
  DEVICE_NO_ERROR, BLE_NO_ERROR, USB_NO_ERROR
]);

var KoovBle = undefined;

function Device_BTS01(opts)
{
  this.id = device_id();
  this.type = 'ble';
  this.name = opts.name;
  this.friendly_name = opts.name + ' (' + opts.periph.address + ')';
  /*
   * Underlying device.
   */
  this.dev = opts.dev;
  this.periph = opts.periph;
  /*
   * Wrapper object to emulate serial device.
   */
  this.serial = null;
  this.board = null;
  this.action = null;
  this.listeners = [];
  this.write_callback = null;

  const ble_opts = KoovBle.BLE_OPTS.BTS01;
  const done = (err) => {
    if (this.write_callback) {
      const callback = this.write_callback;
      this.write_callback = null;
      return error(err ? BLE_WRITE_ERROR : BLE_NO_ERROR, err, callback);
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
      return error(BLE_NO_ERROR, null, cb);
    }
    this.serial = {
      close: (cb) => {
        this.dev.stopReading(() => {
          this.dev.disconnect((err) => {
            return error(err ? BLE_DISCONNECT_ERROR : BLE_NO_ERROR, err, cb);
          });
        });
      },
      write: (data, cb) => {
        //debug('writing', data);
        this.dev.write(data, (err) => {
          //debug('write done', err, data);
          if (cb)
            return error(err ? BLE_WRITE_ERROR : BLE_NO_ERROR, err, cb);
        });
      },
      on: (type, cb) => {
        debug('ble.on', type);
        if (type === 'close' || type === 'disconnect') {
          if (this.listeners.find(x => x.name === 'disconnect')) {
            debug('ble.on ${type}: disconnected handler already installed');
            return;
          }
          let handler = () => {
            debug('disconnected');
            cleanup();
            done({ msg: 'write failure: disconnected' });
            return error(BLE_NO_ERROR, null, cb);
          };
          this.dev.on('disconnect', handler);
          this.listeners.push({ name: 'disconnect', handler: handler });
          return;
        }
        if (type === 'data') {
          /*
           * cb is data callback.
           */
          this.dev.read(cb);
          this.listeners.push({ name: 'data', handler: cb });
          return;
        }
        debug(`on: NOT SUPPPORTED TYPE: ${type}`);
      }
    };
    this.dev.connectAndSetUp((err) => {
      debug(`connectAndSetUp: ${err}`);
      const ecode = (() => {
        if (!err)
          return BLE_NO_ERROR;
        if (typeof err === 'object' && err.deviceNotPaired)
          return BLE_DEVICE_NOT_PAIRED;
        return BLE_CONNECT_ERROR;
      })();
      return error(ecode, err, cb);
    });
  };
  this.open = (cb) => {
    debug(`open: ble`);
    this.open_device((err) => {
      if (error_p(err))
        this.serial = null;
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
      return error(BLE_NO_ERROR, null, cb);
    }
  };
  const reset_koov = (cb) => {
    this.open_device((err) => {
      debug('reset_koov: open', err);
      if (error_p(err)) {
        debug('reset_koov: exit', err);
        return cb(err);
      }
      const handler = () => { debug('reset_koov: ignore disconnected'); };
      this.dev.on('disconnect', handler);
      this.listeners.push({ name: 'disconnect', handler: handler });
      debug('reset_koov: writing 1, 0');
      /* Hold reset */
      this.dev.writeGPIO(new Buffer([1, 0]), (err) => {
        debug('reset_koov: wrote 1, 0', err);
        if (err)                // err is BLE error.
          return error(BLE_GPIO_ERROR, err, cb);
        /* Wait 10ms, then release */
        setTimeout(() => {
          debug('reset_koov: writing 1, 2', err);
          /*
           * The callback of this writeGPIO might not called if
           * bootloader resets BTS01 immediately.  So, we'll call
           * close with timeout, and continue the work.
           */
          this.dev.writeGPIO(new Buffer([1, 2]), (err) => {
            debug('reset_koov: wrote 1, 2', err);
          });
          setTimeout(() => {
            this.close((err) => {
              debug('reset_koov: close', err);
              setTimeout(() => {
                debug('reset_koov: callback', err);
                return cb(err);
              }, 100);
            });
          }, 100);
        }, 1000);
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
        if (!error_p(err) && data.length > 0)
          return write20(data, callback);
        return callback(err);
      });
    };
    return write20(data, done);
  };
  this.on = function(what, cb) {
    debug(`ble.on ${what}:`, cb);
    if (!this.serial)
      return error(BLE_NO_DEVICE, { msg: 'no serial device' }, cb);
    this.serial.on(what, cb);
  };
}

function scan_ble(cb, timeout) {
  if (!KoovBle) {
    cb('ble', null, []);
    return;
  }

  debug('scan ble', timeout);

  let found = [];
  const discoverCallback = dev => {
    debug('discoverAll', dev);
    const name = dev._peripheral.advertisement.localName;
    if (!found.find(x => x.dev.id === dev.id))
      found.push({ name: name, dev: dev, periph: dev._peripheral });
  };
  KoovBle.discoverAll(discoverCallback);

  setTimeout(() => {
    KoovBle.stopDiscoverAll(discoverCallback);
    cb('ble', null, found.sort((a, b) => {
      return a.dev.id < b.dev.id ? -1 : a.dev.id > b.dev.id ? 1 : 0;
    }).map(x => new Device_BTS01(x)));
  }, timeout);
}

/*
 * Predicate for normal koov device file.
 */
const is_koovdev = x => {
  debug(`is_koovdev`, x);
  return x.vendorId === '0x054c' && x.productId === '0x0be6' ||
    x.vendorId === '0x54c' && x.productId === '0xbe6' ||
    (x.pnpId && x.pnpId.match(/VID_054C&PID_0BE6/));
};

/*
 * Predicate for koov device file under bootloader mode.
 */
const is_bootdev = x => {
  debug(`is_bootdev`, x);
  return x.vendorId === '0x054c' && x.productId === '0x0bdc' ||
    x.vendorId === '0x54c' && x.productId === '0xbdc' ||
    (x.pnpId && x.pnpId.match(/VID_054C&PID_0BDC/));
};

const device_id = (() => {
  let id = 0;
  return () => { return id++; };
})();

var KoovSerialPort = undefined;

function Device_USB(opts)
{
  this.id = device_id();
  this.type = 'usb';
  this.name = opts.name;
  this.dev = opts.dev;
  this.board = null;
  this.action = null;
  this.serial = null;
  this.closed = false;
  this.listeners = [];

  const cleanup = () => {
    this.listeners.forEach(l => {
      this.serial.removeListener(l.name, l.handler);
    });
    this.listeners = [];
    this.serial = null;
  };
  this.open_device = (cb) => {
    debug(`open_device: ${this.name}`);
    const sp = new KoovSerialPort(this.name, {
      baudRate: 57600,
      autoOpen: false,
      bufferSize: 1,
      parser: KoovSerialPort.parsers.raw
    });
    this.serial = sp;
    this.closed = false;
    sp.open((err) => {
      debug(`open_device: ${this.name}:`, err);
      if (err)
        this.serial = null;
      return error(err ? USB_OPEN_ERROR : USB_NO_ERROR, err, cb);
    });
  };
  this.open = function(cb) {
    debug('usb open');
    if (is_bootdev(this.dev))
      return error(USB_UNEXPECTED_BOOTLOADER, {
        msg: 'cannot open in bootloader mode'
      }, cb);
    /*
     * Settings copied from firmata.js.  The value of baudrate doesn't
     * matter actually, since there is no serial port between host and
     * target M0/M0 pro.
     */
    const serial_settings = {
      baudRate: 57600,
      autoOpen: false,
      bufferSize: 1
    };
    const serial = new KoovSerialPort(this.name, serial_settings);
    this.serial = serial;
    this.closed = false;
    serial.open((err) => {
      debug('serial open', err);
      if (err)
        this.serial = null;
      return error(err ? USB_OPEN_ERROR : USB_NO_ERROR, err, cb);
    });
  };
  const close_device = (serial, cb) => {
    if (!serial || this.closed)
      return cb(null);
    this.closed = true;
    serial.close(cb);
  };
  this.close = function(cb) {
    debug('close: usb');
    if (this.serial) {
      const serial = this.serial;
      cleanup();
      return close_device(serial, (err) => {
        debug('close: serial.close', err);
        return error(USB_NO_ERROR, null, cb);
      });
    } else
      return error(USB_NO_ERROR, null, cb);
  };
  const touch1200 = (cb) => {
    /*
     * Open device with 1200 baud and close to put device into
     * bootloader.
     */
    const openclose = (cb) => {
      const sp = new KoovSerialPort(this.name, {
        baudRate: 1200,
        autoOpen: false
      });
      sp.open((err) => {
        debug('touch1200: open', err);
        if (err) {
          /*
           * Since device reboots, further USB transaction from host
           * will result an error.  We ignore this error since usually
           * device turns into bootloader mode.  We will get timeout
           * if device fails to switch to bootloader.
           */
          debug('touch1200: ignore error:', err.message);
          return error(USB_NO_ERROR, null, cb);
        }
        sp.close((err) => {
          debug('touch1200: close', err);
          return error(err ? USB_CLOSE_ERROR : USB_NO_ERROR, err, cb);
        });
      });
    };
    /*
     * List serial device file and find bootloader in it.
     */
    const find_bootloader = (cont) => {
      KoovSerialPort.list((err, ports) => {
        if (err)                // err is USB error.
          return error(USB_LIST_ERROR, err, cb);
        const port = ports.find(is_bootdev);
        if (port) {
          let name = port.comName;
          debug(`switch device from ${this.name} to ${name}`);
          this.name = name;
          // Add small delay after finding bootloader device.  OSX
          // sometimes fails to open bootloader device without this
          // delay.
          return setTimeout(() => {
            return error(USB_NO_ERROR, { error: false, name: name }, cb);
          }, 100);
        }
        return cont();
      });
    };
    const times = (count, timeout, cb) => {
      const cont = () => {
        setTimeout(() => { cb(--count, cont); }, timeout);
      };
      return cont();
    };
    find_bootloader(() => {
      openclose(err => {
        if (error_p(err))
          return cb(err);
        times(50, 100, (count, cont) => {
          find_bootloader(() => {
            if (count <= 0)
              return error(USB_NO_BOOTLOADER, {
                msg: 'no bootloader device found'
              }, cb);
            cont();
          });
        });
      });
    });
  };
  this.serial_write = function(data, cb) {
    if (!this.serial)
      return error(DEVICE_NO_DEVICE, { msg: 'device is not open' }, cb);
    this.serial.write(data, (err) => {
      if (err) {
        debug('usb.write:', err);
        return close_device(this.serial, (_) => {
          debug('usb.write: close', _);
          return error(USB_WRITE_ERROR, err, cb);
        });
      }
      return error(USB_NO_ERROR, err, cb);
    });
  };
  this.on = function(what, cb) {
    debug('usb.on ${what}:', cb);
    this.listeners.push({ name: what, handler: cb });
    this.serial.on(what, cb);
  };
  this.reset_koov = touch1200;
}

function scan_usb(cb, timeout)
{
  var sp = KoovSerialPort;
  debug('scan usb');
  sp.list((err, ports) => {
    var devs = ports.reduce((acc, x) => {
      debug('scan found', x);
      const found = [
        /^.dev.(tty|cu).usb.*/,
        /^.dev.ttyACM.*/,
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
  this.list = () => {
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
    this.start_scan = (cb, timeout) => {
      if (!timeout || typeof timeout !== 'object' || !timeout.timeout)
        timeout = 1000;
      else
        timeout = timeout.timeout;
      const callback = (type, err, result) => {
        let x = complete.find(x => x.type === type);

        x.error = err;
        x.result = result;
        x.done = true;
        if (complete.every(x => x.done)) {
          const e = complete.reduce((acc, x) => acc || x.error, null);
          const r = complete.reduce((acc, x) => acc.concat(x.result), []);

          this.candidates = r;
          return error(DEVICE_NO_ERROR, null, (err) => { return cb(e); });
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
      error(DEVICE_UNKNOWN_DEVICE, {msg: `no such device: ${id}`}, callback);
      return false;
    }
    return true;
  };
  this.find_device = (obj, cb) => {
    if (find_device(obj, cb))
      return error(DEVICE_NO_ERROR, null, cb);
  }
  this.open = function(name, cb, err) {
    const open = (err) => {
      if (error_p(err))
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
      return error(DEVICE_NO_ERROR, null, cb);
  };
  this.serial_open = function(cb) {
    if (!this.device)
      return error(DEVICE_NO_DEVICE, { msg: 'device is not found' }, cb);
    this.device.open_device(cb);
  };
  this.serial_write = function(data, cb) {
    if (!this.device)
      return error(DEVICE_NO_DEVICE, { msg: 'device is not found' }, cb);
    if (typeof data === 'object') {
      if (data.type && data.type == 'Buffer') {
        data = data.data;
      }
    }
    this.device.serial_write(data, (err) => {
      //debug('device.serial_write: done', err, data);
      cb(err);
    });
  };
  this.serial_event = function(what, cb, notify) {
    if (!this.device)
      return error(DEVICE_NO_DEVICE, { msg: 'device is not open' }, cb);
    let shortwhat = what.substring('serial-event:'.length);
    this.device.on(shortwhat, (arg) => {
      debug(`${what}:`, arg);
      if (shortwhat == 'data' && typeof arg === 'object') {
        arg = Array.from(arg);
      }
      notify(arg);
    });
    return error(DEVICE_NO_ERROR, null, cb);
  };
  this.reset_koov = function(cb) {
    if (!this.device)
      return error(DEVICE_NO_DEVICE, { msg: 'device is not open' }, cb);
    return this.device.reset_koov(cb);
  };
  this.action = function() {
    return this.device ? this.device.action : null;
  };
};

let device = new Device();
module.exports = {
  device: function(opts) {
    if (opts.debug)
      debug = opts.debug
    KoovSerialPort = opts.serialport;
    KoovBle = opts.ble;
    return device;
  }
};
