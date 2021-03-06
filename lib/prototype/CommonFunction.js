/*
 * @Author: TonyJiangWJ
 * @Date: 2019-11-27 09:03:57
 * @Last Modified by: TonyJiangWJ
 * @Last Modified time: 2020-09-24 22:05:10
 * @Description: 通用方法
 */
importClass(android.content.Context)
importClass(android.provider.Settings)
importClass(java.io.StringWriter)
importClass(java.io.StringReader)
importClass(java.io.PrintWriter)
importClass(java.io.BufferedReader)
importClass(java.lang.StringBuilder)

let { config: _config, storage_name: _storage_name, project_name } = require('../../config.js')(runtime, this)
let singletonRequire = require('../SingletonRequirer.js')(runtime, this)
let Timers = singletonRequire('Timers')
let _runningQueueDispatcher = singletonRequire('RunningQueueDispatcher')
let _FloatyInstance = singletonRequire('FloatyUtil')
let automator = singletonRequire('Automator')
let FileUtils = singletonRequire('FileUtils')
let _logUtils = singletonRequire('LogUtils')
let formatDate = require('../DateUtil.js')

let RUNTIME_STORAGE = _storage_name + "_runtime"
let DISMISS_AWAIT_DIALOG = 'dismissAwaitDialog'
let TIMER_AUTO_START = "timerAutoStart"
let SLEEP_TIME = "sleepTime"

let lifecycleDeamonThreadPool = null
let lifecycleCallbacks = []
let lifecycleLock = threads.lock()
_config.isRunning = true
importClass(java.util.concurrent.LinkedBlockingQueue)
importClass(java.util.concurrent.ThreadPoolExecutor)
importClass(java.util.concurrent.TimeUnit)
importClass(java.util.concurrent.ThreadFactory)
importClass(java.util.concurrent.Executors)
let ENGINE_ID = engines.myEngine().id
// 注册脚本生命周期回调，创建一个单独的线程来监听当前脚本是否已经执行完毕
lifecycleDeamonThreadPool = new ThreadPoolExecutor(1, 1, 60, TimeUnit.SECONDS, new LinkedBlockingQueue(10), new ThreadFactory({
  newThread: function (runnable) {
    let thread = Executors.defaultThreadFactory().newThread(runnable)
    thread.setName(ENGINE_ID + '-lifecycle-deamon-' + thread.getName())
    return thread
  }
}))
lifecycleDeamonThreadPool.execute(function () {
  let count = 0
  while (_config.isRunning) {
    // 每五秒检测一次isRunning
    sleep(5000)
    if (count++ % 5) {
      // 每25秒执行一次，其实在LogUtils中已经有了校验，这里增加判断，冗余一下
      let currentEngine = engines.all().filter(engine => engine.id === ENGINE_ID)
      _config.isRunning = currentEngine && currentEngine.length > 0
    }
  }
  console.verbose('脚本已经中止执行，执行生命周期回调')
  // 脚本已经结束，执行callbacks
  if (lifecycleCallbacks && lifecycleCallbacks.length > 0) {
    lifecycleCallbacks.forEach(callback => {
      callback()
    })
  }
  // 新建线程 关闭线程池
  let thread = new Thread(new java.lang.Runnable({
    run: function () {
      try {
        lifecycleDeamonThreadPool.shutdown()
        let flag = lifecycleDeamonThreadPool.awaitTermination(5, java.util.concurrent.TimeUnit.SECONDS)
        console.verbose('lifecycleDeamon线程池关闭：' + flag)
      } catch (e) {
        console.error('关闭lifecycleDeamon线程池异常:' + e)
      } finally {
        lifecycleDeamonThreadPool = null
      }
    }
  }))
  thread.setName(ENGINE_ID + "_shutdown_lifecycle_thread")
  thread.start()
})


function CommonFunctions () {

  /**
   * 自动设置刘海的偏移量
   */
  this.autoSetUpBangOffset = function () {
    if (_config.auto_set_bang_offset || _config.updated_temp_flag_1325) {
      let DETECT_COLOR = '#10FF1F'
      let window = floaty.rawWindow(
        <frame id="container" gravity="center" bg="#10FF1F">
          <horizontal margin="10 0" gravity="center">
            <text id="text" text="TEXT FLOATY" textSize="10sp" />
          </horizontal>
        </frame>
      )
      window.setPosition(100, 0)
      // 等待悬浮窗初始化
      sleep(300)
      let offset = null
      let limit = 10
      while (!offset && offset !== 0 && limit-- > 0) {
        let screen = this.checkCaptureScreenPermission()
        if (screen) {
          let point = images.findColor(screen, DETECT_COLOR, { region: [80, 0, 100, 300], threshold: 1 })
          if (point && images.detectsColor(screen, DETECT_COLOR, point.x + 20, point.y) && images.detectsColor(screen, DETECT_COLOR, point.x + 30, point.y)) {
            offset = point.y
            ui.run(function () {
              window.text.setText('刘海偏移量为：' + offset + ' 自动关闭悬浮窗')
            })
            _logUtils.debugInfo(['自动设置刘海偏移量为：{}', offset])
            sleep(500)
            debugInfo('关闭悬浮窗')
            window.close()
            let configStorage = storages.create(_storage_name)
            // 设为负值
            _config.bang_offset = -offset
            configStorage.put('bang_offset', _config.bang_offset)
            configStorage.put('auto_set_bang_offset', false)
            configStorage.put('updated_temp_flag_1325', false)
          } else {
            sleep(100)
          }
        }
      }
      if (limit <= 0) {
        _logUtils.warnInfo('无法自动检测刘海高度，请确认是否开启了深色模式？')
      }
    }
  }

  /**
   * 注册生命周期回调，在退出时执行func
   * @param {function} func 回调方法
   * @param {String} desc 过程描述
   */
  this.registerOnEngineRemoved = function (func, desc) {
    desc = desc || 'common func'
    lifecycleLock.lock()
    lifecycleCallbacks.push(func)
    lifecycleLock.unlock()
  }

  /**
   * 校验是否已经拥有无障碍权限 没有自动获取 前提是获取了adb权限
   * 原作者：MrChen 原始代码来自Pro商店
   * adb授权方法：开启usb调试并使用adb工具连接手机，执行 adb shell pm grant org.autojs.autojspro android.permission.WRITE_SECURE_SETTINGS
   * 取消授权 adb shell pm revoke org.autojs.autojspro android.permission.WRITE_SECURE_SETTINGS
   * 其中免费版包名为 org.autojs.autojs
   * @param {boolean} force 是否强制启用
   */
  this.checkAccessibilityService = function (force) {
    let packageName = this.getAutoJsPackage()
    let requiredService = packageName + '/com.stardust.autojs.core.accessibility.AccessibilityService'
    try {
      let enabledServices = Settings.Secure.getString(context.getContentResolver(), Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES)
      _logUtils.debugInfo(['当前已启用无障碍功能的服务:{}', enabledServices])
      var service = null
      if (enabledServices.indexOf(requiredService) < 0) {
        service = enabledServices + ':' + requiredService
      } else if (force) {
        // 如果强制开启
        service = enabledServices
      }
      if (service) {
        Settings.Secure.putString(context.getContentResolver(), Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES, service)
        Settings.Secure.putString(context.getContentResolver(), Settings.Secure.ACCESSIBILITY_ENABLED, '1')
        _logUtils.infoLog('成功开启AutoJS的辅助服务', true)
      }

      return true
    } catch (e) {
      this.printExceptionStack(e)
      _logUtils.warnInfo('\n请确保已给予 WRITE_SECURE_SETTINGS 权限\n\n授权代码已复制，请使用adb工具连接手机执行(重启不失效)\n\n', true)
      let shellScript = 'adb shell pm grant ' + packageName + ' android.permission.WRITE_SECURE_SETTINGS'
      _logUtils.warnInfo('adb 脚本 已复制到剪切板：[' + shellScript + ']')
      setClip(shellScript)
      return false
    }
  }

  /**
   * 校验截图权限，权限失效则重新启动，根据参数释放任务队列
   * @param {boolean} releaseLock 是否在失败后释放任务队列
   * @param {number} errorLimit 失败尝试次数
   */
  this.checkCaptureScreenPermission = function (releaseLock, errorLimit) {
    let screen = null
    let start = new Date().getTime()
    if (!_config.async_waiting_capture) {
      debugInfo('同步获取截图')
      screen = captureScreen()
    } else {
      errorLimit = errorLimit || 3
      // 获取截图 用于判断是否可收取
      let errorCount = 0
      do {
        let waitResult = this.waitFor(function () {
          let max_try = 10
          while (!screen && max_try-- > 0) {
            screen = captureScreen()
          }
        }, _config.capture_waiting_time || 500)
        if (!screen) {
          _logUtils.warnInfo([
            '获取截图失败 {} {} count:{}',
            !waitResult ? '等待截图超时' + ((errorCount++ == errorLimit - 1) ? ', 建议将获取截图超时时间加长' : '') : '获取截图为NULL',
            errorCount < errorLimit ? '再试一次' : '',
            errorCount
          ])
        }
      } while (!screen && errorCount < errorLimit)
      if (!screen) {
        _logUtils.errorInfo(['获取截图失败多次[{}], 可能已经没有了截图权限，重新执行脚本', errorCount], true)
        automator.back()
        if (releaseLock) {
          _runningQueueDispatcher.removeRunningTask(true)
        } else {
          // 用于取消下一次运行的dialog
          this.getAndUpdateDismissReason('capture-screen-error')
        }
        _runningQueueDispatcher.executeTargetScript(FileUtils.getRealMainScriptPath())
        exit()
      }
    }
    _logUtils.debugInfo(['获取截图耗时：{}ms', new Date().getTime() - start])
    return screen
  }

  this.getAutoJsPackage = function () {
    return context.getPackageName()
  }

  this.getAndUpdateDismissReason = function (newVal) {
    let storedDismissDialogInfo = this.getTodaysRuntimeStorage(DISMISS_AWAIT_DIALOG)
    let oldVal = storedDismissDialogInfo.dismissReason
    storedDismissDialogInfo.dismissReason = newVal
    this.updateRuntimeStorage(DISMISS_AWAIT_DIALOG, storedDismissDialogInfo)
    return oldVal
  }

  /**
   * 启动package
   * @param packageName 需要启动的package名称
   * @param reopen 是否属于重开，重开则不记录启动前package信息
   */
  this.launchPackage = function (packageName, reopen) {
    _logUtils.debugInfo(['准备{}打开package: {}', reopen ? '重新' : '', packageName])
    let currentRunning = currentPackage()
    app.launchPackage(packageName)
    sleep(1000)
    currentRunning = currentPackage()
    let waitCount = 3
    while (currentRunning !== packageName && waitCount-- > 0) {
      _logUtils.debugInfo(['未进入{}，继续等待 当前所在：{}', packageName, currentRunning])
      sleep(1000)
      currentRunning = currentPackage()
    }
    _logUtils.debugInfo(['进入[{}] {}', packageName, (packageName === currentRunning ? '成功' : '失败')])
  }

  this.minimize = function () {
    _logUtils.debugInfo(['直接返回最小化'])
    try {
      let maxRepeat = 10
      while (maxRepeat-- > 0 && (automator.clickBack() || automator.clickClose())) {
        sleep(500)
      }
    } catch (e) {
      errorInfo('尝试返回失败' + e)
      this.printExceptionStack(e)
    }
    back()
  }


  /**
   * @param checkDismissReason 是否校验跳过弹窗
   */
  this.showDialogAndWait = function (checkDismissReason) {
    // 显示悬浮窗之前关闭按键监听，避免操作不当导致界面卡死
    events.removeAllKeyDownListeners('volume_down')
    if (checkDismissReason) {
      let dismissReason = this.getAndUpdateDismissReason('')
      if (dismissReason) {
        _logUtils.debugInfo(['不再展示延迟对话框，{}', dismissReason])
        return
      }
    }

    let continueRunning = true
    let terminate = false
    let showDialog = true
    let lock = threads.lock()
    let complete = lock.newCondition()
    let that = this
    lock.lock()
    threads.start(function () {

      let sleepCount = _config.delayStartTime || 5
      let confirmDialog = dialogs.build({
        title: '即将开始' + project_name,
        content: '将在' + sleepCount + '秒内开始',
        positive: '立即开始',
        positiveColor: '#f9a01c',
        negative: '终止',
        negativeColor: 'red',
        neutral: '延迟五分钟',
        cancelable: false
      })
        .on('positive', () => {
          lock.lock()
          complete.signal()
          lock.unlock()
          showDialog = false
          confirmDialog.dismiss()
        })
        .on('negative', () => {
          continueRunning = false
          terminate = true
          lock.lock()
          complete.signal()
          lock.unlock()
          showDialog = false
          confirmDialog.dismiss()
        })
        .on('neutral', () => {
          continueRunning = false
          lock.lock()
          complete.signal()
          lock.unlock()
          showDialog = false
          confirmDialog.dismiss()
        })
        .show()
      _logUtils.debugInfo(['isShowing：{} isCanceled: {}', confirmDialog.isShowing(), confirmDialog.isCancelled()])
      // 注册当脚本中断时隐藏弹出框
      that.registerOnEngineRemoved(function () {
        _logUtils.infoLog('生命周期结束，准备关闭弹窗')
        if (confirmDialog) {
          confirmDialog.dismiss()
        }
      })
      while (sleepCount-- > 0 && showDialog) {
        sleep(1000)
        confirmDialog.setContent('将在' + sleepCount + '秒内开始')
      }
      confirmDialog.setContent('即将开始...')
      sleep(500)
      lock.lock()
      complete.signal()
      lock.unlock()
      confirmDialog.dismiss()
    })
    complete.await()
    lock.unlock()
    if (terminate) {
      _logUtils.warnInfo('中止执行')
      if (_config.autoSetBrightness) {
        device.setBrightnessMode(1)
      }
      this.cancelAllTimedTasks()
      _runningQueueDispatcher.removeRunningTask()
      exit()
    }
    if (continueRunning) {
      _logUtils.logInfo('立即开始')
    } else {
      _logUtils.logInfo('延迟五分钟后开始')
      if (_config.autoSetBrightness) {
        device.setBrightnessMode(1)
      }
      this.setUpAutoStart(5)
      _runningQueueDispatcher.removeRunningTask()
      exit()
    }
  }

  /**
   * 关闭悬浮窗并将floatyWindow置为空，在下一次显示时重新新建悬浮窗 因为close之后的无法再次显示
   */
  this.closeFloatyWindow = function () {
    _FloatyInstance.close()
  }

  this.showMiniFloaty = function (text, x, y, color) {
    _FloatyInstance.setFloatyInfo({ x: x || _config.min_floaty_x || 150, y: y || _config.min_floaty_y || 20 }, text)
    _FloatyInstance.setFloatyTextColor(color || _config.min_floaty_color || '#00FF00')
  }

  /**
   * 显示悬浮窗 根据配置自动显示mini悬浮窗和可关闭悬浮窗，目前来说不推荐使用可关闭悬浮窗
   * @param text {String} 悬浮窗文字内容
   */
  this.showTextFloaty = function (text) {
    this.showMiniFloaty(text)
  }

  /**
   * 监听音量下键延迟执行
   **/
  this.listenDelayStart = function () {
    let _this = this
    threads.start(function () {
      _logUtils.infoLog('即将开始，按音量下键延迟五分钟执行', true)
      sleep(2000)
      _logUtils.debugInfo('after setMaxListeners')
      events.observeKey()
      _logUtils.debugInfo('after observeKey')
      events.onceKeyDown('volume_down', function (event) {
        if (_config.autoSetBrightness) {
          device.setBrightnessMode(1)
        }
        _logUtils.warnInfo('延迟五分钟后启动脚本', true)
        _this.setUpAutoStart(5)
        engines.myEngine().forceStop()
        _runningQueueDispatcher.removeRunningTask()
        events.removeAllListeners()
        events.recycle()
        exit()
      })
      _logUtils.debugInfo('after setOnceKeyDown')
    })
  }

  this.commonDelay = function (minutes, text) {
    _logUtils.debugInfo('倒计时' + minutes)
    if (typeof text === 'undefined' || text === '') {
      text = '距离下次运行还有['
    }

    minutes = typeof minutes != null ? minutes : 0
    if (minutes === 0) {
      return
    }
    let startTime = new Date().getTime()
    let timestampGap = minutes * 60000
    let i = 0
    let delayLogStampPoint = -1
    let delayLogGap = 0
    let showSeconds = false
    for (; ;) {
      let now = new Date().getTime()
      if (now - startTime > timestampGap) {
        break
      }
      i = (now - startTime) / 60000
      let left = minutes - i
      if (!showSeconds) {
        delayLogGap = i - delayLogStampPoint
        // 半分钟打印一次日志
        if (delayLogGap >= 0.5) {
          delayLogStampPoint = i
          let content = this.formatString('{}{}]分', text, left.toFixed(2))
          this.showTextFloaty(content)
          _logUtils.debugInfo(content)
        }
        // 剩余一分钟时显示为秒
        if (showSeconds === false && left <= 1) {
          this.listenDelayStart()
          showSeconds = true
        }
        sleep(500)
      } else {
        let content = this.formatString('{}{}]秒', text, (left * 60).toFixed(0))
        this.showTextFloaty(content)
        sleep(1000)
      }
    }
  }




  /**
   * 根据传入key创建当日缓存
   */
  this.createTargetStore = function (key, today) {
    if (key === DISMISS_AWAIT_DIALOG) {
      return this.createDismissAwaitDialogStore(today)
    } else if (key === SLEEP_TIME) {
      return this.createSleepTime(today)
    }
  }

  this.createSleepTime = function (today) {
    let initSleepTime = {
      sleepTime: 10,
      count: 0,
      startTime: new Date().getTime(),
      date: today
    }
    let runtimeStorages = storages.create(RUNTIME_STORAGE)
    runtimeStorages.put(SLEEP_TIME, JSON.stringify(initSleepTime))
    return initSleepTime
  }

  this.createDismissAwaitDialogStore = function (today) {
    let initStore = {
      dismissReason: '',
      date: today
    }
    let runtimeStorages = storages.create(RUNTIME_STORAGE)
    runtimeStorages.put(DISMISS_AWAIT_DIALOG, JSON.stringify(initStore))
    return initStore
  }

  /**
     * 获取当天的缓存信息，不存在时创建一个初始值
     * @param key {String} key名称
     */
  this.getTodaysRuntimeStorage = function (key) {
    // 小鸡并不需要当日，脚本会跨日期运行
    let today = 'every-day'
    let runtimeStorages = storages.create(RUNTIME_STORAGE)
    let existStoreObjStr = runtimeStorages.get(key)
    let returnVal = null
    if (existStoreObjStr) {
      try {
        let existStoreObj = JSON.parse(existStoreObjStr)
        if (existStoreObj.date === today) {
          return existStoreObj
        }
      } catch (e) {
        _logUtils.debugInfo(["解析JSON数据失败, key:{} value:{} error:{}", key, existStoreObjStr, e])
      }
    }

    let newStore = this.createTargetStore(key, today)
    return newStore
  }

  /**
   * 通用更新缓存方法
   * @param key {String} key值名称
   * @param valObj {Object} 存值对象
   */
  this.updateRuntimeStorage = function (key, valObj) {
    let runtimeStorages = storages.create(RUNTIME_STORAGE)
    runtimeStorages.put(key, JSON.stringify(valObj))
  }

  this.parseToZero = function (value) {
    return (!value || isNaN(value)) ? 0 : parseInt(value)
  }


  this.isEmpty = function (val) {
    return val === null || typeof val === 'undefined' || val === ''
  }

  this.isEmptyArray = function (array) {
    return array === null || typeof array === 'undefined' || array.length === 0
  }

  this.isNotEmpty = function (val) {
    return !this.isEmpty(val) && !this.isEmptyArray(val)
  }

  this.addOpenPlacehold = function (content) {
    content = "<<<<<<<" + (content || "") + ">>>>>>>"
    _logUtils.appendLog(content)
    console.verbose(content)
  }

  this.addClosePlacehold = function (content) {
    content = ">>>>>>>" + (content || "") + "<<<<<<<"
    _logUtils.appendLog(content)
    console.verbose(content)
  }

  /**
   * @deprecated: see RunningQueueDispatcher$addRunningTask
   * 校验是否重复运行 如果重复运行则关闭当前脚本
   */
  this.checkDuplicateRunning = function () {
    let currentEngine = engines.myEngine()
    let runningEngines = engines.all()
    let runningSize = runningEngines.length
    let currentSource = currentEngine.getSource() + ''
    _logUtils.debugInfo('当前脚本信息 id:' + currentEngine.id + ' source:' + currentSource + ' 运行中脚本数量：' + runningSize)
    if (runningSize > 1) {
      runningEngines.forEach(engine => {
        let compareEngine = engine
        let compareSource = compareEngine.getSource() + ''
        _logUtils.debugInfo('对比脚本信息 id:' + compareEngine.id + ' source:' + compareSource)
        if (currentEngine.id !== compareEngine.id && compareSource === currentSource) {
          _logUtils.warnInfo('脚本正在运行中 退出当前脚本：' + currentSource, true)
          _runningQueueDispatcher.removeRunningTask(true)
          engines.myEngine().forceStop()
          exit()
        }
      })
    }
  }

  /**
   * 关闭运行中的脚本 关闭全部同源脚本
   */
  this.killRunningScript = function () {
    let runningEngines = engines.all()
    let runningSize = runningEngines.length
    let mainScriptJs = FileUtils.getRealMainScriptPath()
    if (runningSize > 1) {
      runningEngines.forEach(engine => {
        let compareEngine = engine
        let compareSource = compareEngine.getSource() + ''
        _logUtils.debugInfo('对比脚本信息 id:' + compareEngine.id + ' source:' + compareSource)
        if (compareSource === mainScriptJs) {
          _logUtils.warnInfo(['关闭运行中脚本：id[{}]', compareEngine.id], true)
          engine.forceStop()
        }
      })
    }
  }

  /**
   * 杀死重复运行的同源脚本
   */
  this.killDuplicateScript = function () {
    let currentEngine = engines.myEngine()
    let runningEngines = null
    while (runningEngines === null) {
      // engines.all()有并发问题，尝试多次获取
      try {
        runningEngines = engines.all()
      } catch (e) {
        sleep(200)
      }
    }
    let runningSize = runningEngines.length
    let currentSource = currentEngine.getSource() + ''
    _logUtils.debugInfo('当前脚本信息 id:' + currentEngine.id + ' source:' + currentSource + ' 运行中脚本数量：' + runningSize)
    if (runningSize > 1) {
      runningEngines.forEach(engine => {
        let compareEngine = engine
        let compareSource = compareEngine.getSource() + ''
        _logUtils.debugInfo('对比脚本信息 id:' + compareEngine.id + ' source:' + compareSource)
        if (currentEngine.id !== compareEngine.id && compareSource === currentSource) {
          _logUtils.warnInfo(['currentId：{} 退出运行中的同源脚本id：{}', currentEngine.id, compareEngine.id])
          // 直接关闭同源的脚本，暂时可以无视锁的存在
          engine.forceStop()
        }
      })
    }
  }

  /**
   * 设置指定时间后自动启动main脚本
   * @param {float} minutes 倒计时时间 单位分
   */
  this.setUpAutoStart = function (minutes) {
    if (minutes <= 0) {
      let newRandomMinutes = parseFloat((0.01 + Math.random()).toFixed(2))
      errorInfo(['倒计时时间必须大于零：{} 现在将倒计时重置为： {}', minutes, newRandomMinutes])
      minutes = newRandomMinutes
    }
    // 先移除所有已设置的定时任务
    this.cancelAllTimedTasks()
    let mainScriptJs = FileUtils.getRealMainScriptPath()
    let millis = new Date().getTime() + minutes * 60 * 1000
    _logUtils.infoLog('预订[' + minutes + ']分钟后的任务，时间戳:' + millis)
    // 预定一个{minutes}分钟后的任务
    let task = Timers.addDisposableTask({
      path: mainScriptJs,
      date: millis
    })
    _logUtils.debugInfo("定时任务预定成功: " + task.id)
    this.recordTimedTask(task)
  }

  this.recordTimedTask = function (task) {
    let runtimeStorage = storages.create(RUNTIME_STORAGE)
    let autoStartListStr = runtimeStorage.get(TIMER_AUTO_START)
    let array = []
    if (autoStartListStr) {
      array = JSON.parse(autoStartListStr)
    }
    array.push(task)
    runtimeStorage.put(TIMER_AUTO_START, JSON.stringify(array))
  }

  this.showAllAutoTimedTask = function () {
    let runtimeStorage = storages.create(RUNTIME_STORAGE)
    let autoStartListStr = runtimeStorage.get(TIMER_AUTO_START)
    if (autoStartListStr) {
      let array = JSON.parse(autoStartListStr)
      if (array && array.length > 0) {
        array.forEach(task => {
          _logUtils.logInfo([
            '定时任务 mId: {} 目标执行时间: {} 剩余时间: {}秒',
            task.mId, formatDate(new Date(task.mMillis), 'yyyy-MM-dd HH:mm:ss'), ((task.mMillis - new Date().getTime()) / 1000.0).toFixed(0)
          ])
        })
      }
    } else {
      _logUtils.logInfo('当前没有自动设置的定时任务')
    }
  }

  this.cancelAllTimedTasks = function () {
    let runtimeStorage = storages.create(RUNTIME_STORAGE)
    let autoStartListStr = runtimeStorage.get(TIMER_AUTO_START)
    if (autoStartListStr) {
      let array = JSON.parse(autoStartListStr)
      if (array && array.length > 0) {
        array.forEach(task => {
          _logUtils.debugInfo('撤销自动任务：' + JSON.stringify(task))
          if (task.mId) {
            Timers.removeTimedTask(task.mId)
          }
        })
      }
    }
    // 将task队列置为空
    runtimeStorage.put(TIMER_AUTO_START, '')
  }

  this.waitFor = function (action, timeout) {
    let countDown = new java.util.concurrent.CountDownLatch(1)
    let actionSuccess = false
    let actionThread = null
    let that = this
    try {
      let start = new Date().getTime()
      actionThread = threads.start(function () {
        try {
          action()
          actionSuccess = true
        } catch (e) {
          _logUtils.warnInfo('action执行异常' + e)
          that.printExceptionStack(e)
        } finally {
          countDown.countDown()
        }
        _logUtils.debugInfo(['action执行结束: {} 耗时：{}ms', actionSuccess, new Date().getTime() - start])
      })
      let waitResult = countDown.await(timeout, java.util.concurrent.TimeUnit.MILLISECONDS)
      _logUtils.debugForDev(['waitFor方法执行完毕，action result: {}, wait result: {} cost time: {}ms', actionSuccess, waitResult, new Date().getTime() - start])
      if (!waitResult) {
        _logUtils.warnInfo(['等待操作超时, 操作时间: {}ms', new Date().getTime() - start])
      }
    } catch (e) {
      this.printExceptionStack(e)
    } finally {
      if (actionThread !== null) {
        actionThread.interrupt()
      }
    }
    return actionSuccess
  }

  this.createQueue = function (size) {
    let queue = []
    for (let i = 0; i < size; i++) {
      queue.push(i)
    }
    return queue
  }

  this.getQueueDistinctSize = function (queue) {
    return queue.reduce((a, b) => {
      if (a.indexOf(b) < 0) {
        a.push(b)
      }
      return a
    }, []).length
  }

  this.pushQueue = function (queue, size, val) {
    if (queue.length >= size) {
      queue.shift()
    }
    queue.push(val)
  }

  /**
  * eg. params '参数名：{} 参数内容：{}', name, value
  *     result '参数名：name 参数内容：value'
  * 格式化字符串，定位符{}
  */
  this.formatString = function () {
    let originContent = []
    for (let arg in arguments) {
      originContent.push(arguments[arg])
    }
    if (originContent.length === 1) {
      return originContent[0]
    }
    let marker = originContent[0]
    let args = originContent.slice(1)
    let regex = /(\{\})/g
    let matchResult = marker.match(regex)
    if (matchResult && args && matchResult.length > 0 && matchResult.length === args.length) {
      args.forEach((item, idx) => {
        marker = marker.replace('{}', item)
      })
      return marker
    } else {
      console.error('参数数量不匹配' + arguments)
      return arguments
    }
  }

  this.printExceptionStack = function (e) {
    if (e) {
      errorInfo(['fileName:{} line:{} typeof e:{}', e.fileName, e.lineNumber, typeof e])
      let throwable = null
      if (e.javaException) {
        throwable = e.javaException
      } else if (e.rhinoException) {
        throwable = e.rhinoException
      }
      if (throwable) {
        let scriptTrace = new StringBuilder(e.message == null ? '' : e.message + '\n');
        let stringWriter = new StringWriter()
        let writer = new PrintWriter(stringWriter)
        throwable.printStackTrace(writer)
        writer.close()
        let bufferedReader = new BufferedReader(new StringReader(stringWriter.toString()))
        let line
        while ((line = bufferedReader.readLine()) != null) {
          scriptTrace.append("\n").append(line)
        }
        errorInfo(scriptTrace.toString())
      } else {
        let funcs = Object.getOwnPropertyNames(e)
        for (let idx in funcs) {
          let func_name = funcs[idx]
          console.verbose(func_name)
        }

      }
    }
  }

  /**
   * 先返回当前睡眠时间，然后再更新睡眠时间数据
   */
  this.getSleepTimeAutoCount = function () {
    let sleepStorage = this.getTodaysRuntimeStorage(SLEEP_TIME)
    let recheckTime = _config.recheckTime || 5
    let returnVal = sleepStorage.sleepTime || recheckTime
    let speeded = sleepStorage.speeded
    sleepStorage.count = (sleepStorage.count || 0) + 1
    let passedCount = sleepStorage.count - 1
    let fullTime = speeded ? 240 : 300
    // 经过的时间 单位分
    let passedTime = (new Date().getTime() - sleepStorage.startTime) / 60000
    // 第一次喂食后 睡眠20分钟，然后循环多次 直到赶走了野鸡或者超时
    if (passedCount === 0) {
      // 后面循环睡眠
      sleepStorage.sleepTime = recheckTime
    } else if (returnVal >= 300 || passedTime <= fullTime && passedTime >= 40) {
      // 揍过鸡后会设置为300 此时重新计算具体时间
      // or
      // 经过了超过40分钟 而且此时没有野鸡来 开始睡眠更久不再检测小鸡
      returnVal = parseInt(fullTime + _config.windowTime - passedTime)
    } else if (passedTime > fullTime) {
      // 300分钟以上的 直接循环等待 理论上不会进到这一步 300分钟以上已经没饭吃了
      returnVal = recheckTime
    }
    sleepStorage.sleepTime = recheckTime
    this.updateRuntimeStorage(SLEEP_TIME, sleepStorage)
    return returnVal
  }


  /**
   * 先返回当前睡眠时间，然后再更新睡眠时间数据
   */
  this.getSleepTimeByOcr = function (restTime) {
    if (restTime < 0) {
      return this.getSleepTimeAutoCount()
    }
    let sleepStorage = this.getTodaysRuntimeStorage(SLEEP_TIME)
    let recheckTime = _config.recheckTime || 5
    let returnVal = 0
    let speeded = sleepStorage.speeded
    // 是否揍过鸡
    let punched = sleepStorage.sleepTime === 300
    sleepStorage.count = (sleepStorage.count || 0) + 1
    let fullTime = speeded ? 240 : 300
    // 经过的时间 单位分
    let passedTime = fullTime - restTime
    if (punched || passedTime > 40) {
      returnVal = restTime + config.windowTime
    } else if (passedTime < 20) {
      returnVal = 20 - passedTime
    } else {
      returnVal = recheckTime
    }
    sleepStorage.sleepTime = recheckTime
    this.updateRuntimeStorage(SLEEP_TIME, sleepStorage)
    return returnVal
  }

  this.getSleepTime = function () {
    let sleepStorage = this.getTodaysRuntimeStorage(SLEEP_TIME)
    return sleepStorage.sleepTime || 10
  }

  this.getSleepStorage = function () {
    return this.getTodaysRuntimeStorage(SLEEP_TIME)
  }

  /**
   * @param {number} sleepTime 下一次获取到需要睡眠的时间 单位分
   * @param {boolean} resetCount
   */
  this.updateSleepTime = function (sleepTime, resetCount) {
    let currentSleepTime = this.getTodaysRuntimeStorage(SLEEP_TIME)
    currentSleepTime.sleepTime = sleepTime || 10
    if (resetCount) {
      currentSleepTime.count = 0
      currentSleepTime.startTime = new Date().getTime()
    }
    this.updateRuntimeStorage(SLEEP_TIME, currentSleepTime)
  }

  this.setSpeeded = function () {
    let currentSleepTime = this.getTodaysRuntimeStorage(SLEEP_TIME)
    currentSleepTime.speeded = true
    this.updateRuntimeStorage(SLEEP_TIME, currentSleepTime)
  }

  this.setSpeedFail = function () {
    let currentSleepTime = this.getTodaysRuntimeStorage(SLEEP_TIME)
    currentSleepTime.speeded = false
    this.updateRuntimeStorage(SLEEP_TIME, currentSleepTime)
  }

  this.showRuntimeStatus = function () {
    console.log('自动定时任务：' + JSON.stringify(this.getTodaysRuntimeStorage(TIMER_AUTO_START)))
    console.log('睡眠时间：' + JSON.stringify(this.getTodaysRuntimeStorage(SLEEP_TIME)))
  }

  /**
   * 将当日运行时数据导出
   */
  this.exportRuntimeStorage = function () {
    let runtimeStorageInfo = {
      storageName: RUNTIME_STORAGE,
      storeList: []
    }
    let keyList = [TIMER_AUTO_START, SLEEP_TIME]
    let runtimeStorages = storages.create(RUNTIME_STORAGE)
    keyList.forEach(key => {
      let storageStr = runtimeStorages.get(key)
      _logUtils.debugInfo(['导出运行数据 key「{}」value 「{}」', key, storageStr])
      runtimeStorageInfo.storeList.push({
        key: key,
        storageStr: storageStr
      })
    })
    _logUtils.infoLog('运行时数据导出成功', true)
    return JSON.stringify(runtimeStorageInfo)
  }

  /**
   * 导入并覆盖当日运行时数据
   */
  this.importRuntimeStorage = function (str) {
    let runtimeStorageInfo = JSON.parse(str)
    if (runtimeStorageInfo && runtimeStorageInfo.storageName && runtimeStorageInfo.storeList && runtimeStorageInfo.storeList.length > 0) {
      let runtimeStorages = storages.create(runtimeStorageInfo.storageName)
      runtimeStorageInfo.storeList.forEach(r => {
        _logUtils.debugInfo(['导入运行数据 key「{}」value 「{}」', r.key, r.storageStr])
        runtimeStorages.put(r.key, r.storageStr)
      })
      _logUtils.infoLog('运行时数据导入成功', true)
      return true
    }
    return false
  }

  /**
   * 杀死当前APP 仅适用于MIUI10+ 全面屏手势操作
   * 当未开启手势关闭 @code {config.killAppWithGesture==false} 时，仅仅返回操作 返回两次 相当于先关闭蚂蚁庄园，再缩小支付宝
   */
  this.killCurrentApp = function () {
    if (_config.killAppWithGesture) {
      recents()
      sleep(1000)
      gesture(320, [240, 1000], [800, 1000])
      sleep(400)
      home()
    } else {
      back()
      sleep(1000)
      back()
    }
  }
}

module.exports = new CommonFunctions()