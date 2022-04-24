const LAST_CONNECTED_DEVICE = 'last_connected_device'
const PrinterJobs = require('../../printer/printerjobs')
const printerUtil = require('../../printer/printerutil')

function inArray(arr, key, val) {
  for (let i = 0; i < arr.length; i++) {
    if (arr[i][key] === val) {
      return i
    }
  }
  return -1
}

function ab2str(buf) {
  return String.fromCharCode.apply(null, new Uint8Array(buf));
}

// ArrayBuffer转16进度字符串示例
function ab2hex(buffer) {
  const hexArr = Array.prototype.map.call(
    new Uint8Array(buffer),
    function (bit) {
      return ('00' + bit.toString(16)).slice(-2)
    }
  )
  return hexArr.join(',')
}

function str2ab(str) {
  // Convert str to ArrayBuff and write to printer
  let buffer = new ArrayBuffer(str.length)
  let dataView = new DataView(buffer)
  for (let i = 0; i < str.length; i++) {
    dataView.setUint8(i, str.charAt(i).charCodeAt(0))
  }
  return buffer;
}

Page({
  data: {
    devices: [],
    connected: false,
    chs: [],
    barcode :[],
  },
  onUnload() {
    this.closeBluetoothAdapter()
  },
  openBluetoothAdapter() {
    if (!wx.openBluetoothAdapter) {
      wx.showModal({
        title: '提示',
        content: '当前微信版本过低，无法使用该功能，请升级到最新微信版本后重试。'
      })
      return
    }
    wx.openBluetoothAdapter({
      success: (res) => {
        console.log('openBluetoothAdapter success', res)
        this.startBluetoothDevicesDiscovery()
      },
      fail: (res) => {
        console.log('openBluetoothAdapter fail', res)
        if (res.errCode === 10001) {
          wx.showModal({
            title: '错误',
            content: '未找到蓝牙设备, 请打开蓝牙后重试。',
            showCancel: false
          })
          wx.onBluetoothAdapterStateChange((res) => {
            console.log('onBluetoothAdapterStateChange', res)
            if (res.available) {
              // 取消监听，否则stopBluetoothDevicesDiscovery后仍会继续触发onBluetoothAdapterStateChange，
              // 导致再次调用startBluetoothDevicesDiscovery
              wx.onBluetoothAdapterStateChange(() => {
              });
              this.startBluetoothDevicesDiscovery()
            }
          })
        }
      }
    })
    wx.onBLEConnectionStateChange((res) => {
      // 该方法回调中可以用于处理连接意外断开等异常情况
      console.log('onBLEConnectionStateChange', `device ${res.deviceId} state has changed, connected: ${res.connected}`)
      this.setData({
        connected: res.connected
      })
      if (!res.connected) {
        wx.showModal({
          title: '错误',
          content: '蓝牙连接已断开',
          showCancel: false
        })
      }
    });
  },
  getBluetoothAdapterState() {
    wx.getBluetoothAdapterState({
      success: (res) => {
        console.log('getBluetoothAdapterState', res)
        if (res.discovering) {
          this.onBluetoothDeviceFound()
        } else if (res.available) {
          this.startBluetoothDevicesDiscovery()
        }
      }
    })
  },
  startBluetoothDevicesDiscovery() {
    if (this._discoveryStarted) {
      return
    }
    this._discoveryStarted = true
    wx.startBluetoothDevicesDiscovery({
      success: (res) => {
        console.log('startBluetoothDevicesDiscovery success', res)
        this.onBluetoothDeviceFound()
      },
      fail: (res) => {
        console.log('startBluetoothDevicesDiscovery fail', res)
      }
    })
  },
  stopBluetoothDevicesDiscovery() {
    wx.stopBluetoothDevicesDiscovery({
      complete: () => {
        console.log('stopBluetoothDevicesDiscovery')
        this._discoveryStarted = false
      }
    })
  },
  onBluetoothDeviceFound() {
    wx.onBluetoothDeviceFound((res) => {

      console.log('onBluetoothDeviceFound res',res)
      res.devices.forEach(device => {
        if (!device.name && !device.localName) { 
          return
        }

      console.log('onBluetoothDeviceFound device',device)

        const foundDevices = this.data.devices
        const idx = inArray(foundDevices, 'deviceId', device.deviceId)
        const data = {}
        if (idx === -1) {
          data[`devices[${foundDevices.length}]`] = device
        } else {
          data[`devices[${idx}]`] = device
        }
        this.setData(data)
      })
    })
  },
  createBLEConnection(e) {
    const ds = e.currentTarget.dataset
    const deviceId = ds.deviceId
    const name = ds.name
    this._createBLEConnection(deviceId, name)
  },
  _createBLEConnection(deviceId, name) {
    wx.showLoading()
    wx.createBLEConnection({
      deviceId,
      success: () => {
        console.log('createBLEConnection success');
        this.setData({
          connected: true,
          name,
          deviceId,
        })
        this.getBLEDeviceServices(deviceId)
        wx.setStorage({
          key: LAST_CONNECTED_DEVICE,
          data: name + ':' + deviceId
        })
      },
      complete() {
        wx.hideLoading()
      },
      fail: (res) => {
        console.log('createBLEConnection fail', res)
      }
    })
    this.stopBluetoothDevicesDiscovery()
  },
  closeBLEConnection() {
    wx.closeBLEConnection({
      deviceId: this.data.deviceId
    })
    this.setData({
      connected: false,
      chs: [],
      canWrite: false,
      barcode:[],
    })
  },
  getBLEDeviceServices(deviceId) {
    wx.getBLEDeviceServices({
      deviceId,
      success: (res) => {
        console.log('getBLEDeviceServices', res)
        for (let i = 0; i < res.services.length; i++) {
          if (res.services[i].isPrimary) {
            this.getBLEDeviceCharacteristics(deviceId, res.services[i].uuid) 
          }
        }
      }
    })
  },
  getBLEDeviceCharacteristics(deviceId, serviceId) {
    let that = this;
    wx.getBLEDeviceCharacteristics({
      deviceId,
      serviceId,
      success: (res) => {
        console.log('getBLEDeviceCharacteristics success', res.characteristics)
        // 这里会存在特征值是支持write，写入成功但是没有任何反应的情况
        // 只能一个个去试
        for (let i = 0; i < res.characteristics.length; i++) { 
          const item = res.characteristics[i]
          if (item.properties.indicate){
            console.log('getBLEDeviceCharacteristics indicate item is true', item)
          }else{
            console.log('getBLEDeviceCharacteristics indicate item is false', item)
            return
          }
          if ( item.properties.notify && item.properties.indicate) {
            this.setData({
              canWrite: true
            })
            this._deviceId = deviceId
            this._serviceId = serviceId
            this._characteristicId = item.uuid


            wx.notifyBLECharacteristicValueChange({
              characteristicId: item.uuid,
              
              deviceId: deviceId,
              
              serviceId: serviceId,
              
              state: true,
              type:'notification',
              fail (res) {
                  console.log({res})
              },
              complete:function(res){ 
                console.log('44444444444444444444444',res)
        
              },
              success:function(res){
              
              console.log('notify启用',res); 
                  wx.onBLECharacteristicValueChange((result) => { 
                    console.log('监听特征值变化',result); 
                    const barcode = [ab2str(result.value),...that.data.barcode];
                    that.setData({barcode}) 
                  })
              }
              
              });

              let buffer = new ArrayBuffer(1)
              let dataView = new DataView(buffer)
              dataView.setUint8(0, 0)
              console.log('要发送的信息是：' ,buffer)

              setTimeout(function(){ 
                var thisWriteDeviceId = deviceId
          
                var thisWriteServiceId =  serviceId
          
                var thisWriteCharacteristicId =item.uuid
          
                  wx.writeBLECharacteristicValue({
            
                    deviceId: thisWriteDeviceId,
            
                    serviceId: thisWriteServiceId,
            
                    characteristicId: thisWriteCharacteristicId,
            
                    value: buffer,
            
                    success: function(res) { 
                      console.log(res,"发送成功"); 
                    },
            
                    fail: function(res){ 
                      console.log(res,"发送失败." ); 
                    },
            
                    complete: function(ret){
                        console.log(res,"发送失败." ); 
                    }
                  });
                },500); 
          ///
            /**
               * 坑就在这里了，对于安卓系统，需要添加下面这段代码。你写完数据后，还必须读一次，才能被onBLECharacteristicValueChange监听到，才会把数据返回给你，
               * 但在苹果系统里面就不能有下面这段代码了，因为如果你添加上去的话，会出现发一次指令出现两次返回值的情况
               */ 
                  wx.readBLECharacteristicValue({
                    deviceId: deviceId,
                    serviceId: serviceId,
                    characteristicId: item.uuid,
                    success: function (res) {
                        console.log('readBLECharacteristicValue',res)
                    },fail(res){
                      console.log('fail',res)
                    }
                }) 

            break;
          }
        }
      },
      fail(res) {
        console.error('getBLEDeviceCharacteristics', res)
      }
    })
  },
  writeBLECharacteristicValue() {
    let printerJobs = new PrinterJobs();
    printerJobs
      .print('2018年12月5日17:34')
      .print(printerUtil.fillLine())
      .setAlign('ct')
      .setSize(2, 2)
      .print('#20饿了么外卖')
      .setSize(1, 1)
      .print('切尔西Chelsea')
      .setSize(2, 2)
      .print('在线支付(已支付)')
      .setSize(1, 1)
      .print('订单号：5415221202244734')
      .print('下单时间：2017-07-07 18:08:08')
      .setAlign('lt')
      .print(printerUtil.fillAround('一号口袋'))
      .print(printerUtil.inline('意大利茄汁一面 * 1', '15'))
      .print(printerUtil.fillAround('其他'))
      .print('餐盒费：1')
      .print('[赠送康师傅冰红茶] * 1')
      .print(printerUtil.fillLine())
      .setAlign('rt')
      .print('原价：￥16')
      .print('总价：￥16')
      .setAlign('lt')
      .print(printerUtil.fillLine())
      .print('备注')
      .print("无")
      .print(printerUtil.fillLine())
      .println();

    let buffer = printerJobs.buffer();
    console.log('ArrayBuffer', 'length: ' + buffer.byteLength, ' hex: ' + ab2hex(buffer));
    // 1.并行调用多次会存在写失败的可能性
    // 2.建议每次写入不超过20字节
    // 分包处理，延时调用
    const maxChunk = 20;
    const delay = 20;
    for (let i = 0, j = 0, length = buffer.byteLength; i < length; i += maxChunk, j++) {
      let subPackage = buffer.slice(i, i + maxChunk <= length ? (i + maxChunk) : length);
      setTimeout(this._writeBLECharacteristicValue, j * delay, subPackage);
    }
  },
  _writeBLECharacteristicValue(buffer) {
    wx.writeBLECharacteristicValue({
      deviceId: this._deviceId,
      serviceId: this._serviceId,
      characteristicId: this._characteristicId,
      value: buffer,
      success(res) {
        console.log('writeBLECharacteristicValue success', res)
      },
      fail(res) {
        console.log('writeBLECharacteristicValue fail', res)
      }
    })
  },
  closeBluetoothAdapter() {
    wx.closeBluetoothAdapter()
    this._discoveryStarted = false
  },
  onLoad(options) {
    const lastDevice = wx.getStorageSync(LAST_CONNECTED_DEVICE);
    this.setData({
      lastDevice: lastDevice
    })
  },
  createBLEConnectionWithDeviceId(e) {
    // 小程序在之前已有搜索过某个蓝牙设备，并成功建立连接，可直接传入之前搜索获取的 deviceId 直接尝试连接该设备
    const device = this.data.lastDevice
    if (!device) {
      return
    }
    const index = device.indexOf(':');
    const name = device.substring(0, index);
    const deviceId = device.substring(index + 1, device.length);
    console.log('createBLEConnectionWithDeviceId', name + ':' + deviceId)
    wx.openBluetoothAdapter({
      success: (res) => {
        console.log('openBluetoothAdapter success', res)
        this._createBLEConnection(deviceId, name)
      },
      fail: (res) => {
        console.log('openBluetoothAdapter fail', res)
        if (res.errCode === 10001) {
          wx.showModal({
            title: '错误',
            content: '未找到蓝牙设备, 请打开蓝牙后重试。',
            showCancel: false
          })
          wx.onBluetoothAdapterStateChange((res) => {
            console.log('onBluetoothAdapterStateChange', res)
            if (res.available) {
              // 取消监听
              wx.onBluetoothAdapterStateChange(() => {
              });
              this._createBLEConnection(deviceId, name)
            }
          })
        }
      }
    })
  }
})