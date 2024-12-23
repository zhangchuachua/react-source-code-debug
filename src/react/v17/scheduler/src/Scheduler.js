/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

/* eslint-disable no-var */

import {
  enableSchedulerDebugging,
  enableProfiling,
} from './SchedulerFeatureFlags';
import {
  requestHostCallback,
  requestHostTimeout,
  cancelHostTimeout,
  shouldYieldToHost,
  getCurrentTime,
  forceFrameRate,
  requestPaint,
} from './SchedulerHostConfig';
import { push, pop, peek } from './SchedulerMinHeap';

// TODO: Use symbols?
import {
  ImmediatePriority,
  UserBlockingPriority,
  NormalPriority,
  LowPriority,
  IdlePriority,
} from './SchedulerPriorities';
import {
  sharedProfilingBuffer,
  markTaskRun,
  markTaskYield,
  markTaskCompleted,
  markTaskCanceled,
  markTaskErrored,
  markSchedulerSuspended,
  markSchedulerUnsuspended,
  markTaskStart,
  stopLoggingProfilingEvents,
  startLoggingProfilingEvents,
} from './SchedulerProfiling';

// Max 31 bit integer. The max integer size in V8 for 32-bit systems.
// Math.pow(2, 30) - 1
// 0b111111111111111111111111111111
var maxSigned31BitInt = 1073741823;

// Times out immediately
var IMMEDIATE_PRIORITY_TIMEOUT = -1;
// Eventually times out
var USER_BLOCKING_PRIORITY_TIMEOUT = 250;
var NORMAL_PRIORITY_TIMEOUT = 5000;
var LOW_PRIORITY_TIMEOUT = 10000;
// Never times out
var IDLE_PRIORITY_TIMEOUT = maxSigned31BitInt;

// Tasks are stored on a min heap
var taskQueue = [];
var timerQueue = [];

// Incrementing id counter. Used to maintain insertion order.
var taskIdCounter = 1;

// Pausing the scheduler is useful for debugging.
var isSchedulerPaused = false;

var currentTask = null;
var currentPriorityLevel = NormalPriority;

// This is set while performing work, to prevent re-entrancy.
var isPerformingWork = false;// *为 true 的话，表示正在执行任务，可以大致理解为在 flushWork 到 workLoop 中

var isHostCallbackScheduled = false;// *为 ture 的话，表示已经有任务被调度了，可以大致理解为已经有任务被放到 taskQueue 里面了，但是还没有到 flushWork 的阶段；
var isHostTimeoutScheduled = false;// *为 true 的话，表示已经有一个 setTimeout 被调度了，因为 schedule 只能使用一个 setTimeout 用来计时，处理 timerQueue 中的任务，所以需要一个全局变量进行监控；

/**
 * @desc 将 timerQueue 中过期的 timer 提出来，然后放到 taskQueue
 * @param currentTime
 */
function advanceTimers(currentTime) {
  // Check for tasks that are no longer delayed and add them to the queue.
  // 检查过期任务队列中不应再被推迟的，放到taskQueue中
  let timer = peek(timerQueue);// 获取堆顶
  while (timer !== null) {
    if (timer.callback === null) {
      // Timer was cancelled.
      pop(timerQueue);
    } else if (timer.startTime <= currentTime) {// 当前时间 > 开始时间，那么说明应该开始了
      // Timer fired. Transfer to the task queue.
      pop(timerQueue);// peek 只是获取堆顶，pop 把这个 timer 弹出
      timer.sortIndex = timer.expirationTime;
      push(taskQueue, timer);// 将 timer 押入正常队列 taskQueue
      if (enableProfiling) {
        markTaskStart(timer, currentTime);
        timer.isQueued = true;
      }
    } else {
      // *因为是最小堆，堆顶就是 expirationTime 就是最小的，如果堆顶都没有过期的话，那么说明其他的也没有过期
      // Remaining timers are pending.
      return;
    }
    timer = peek(timerQueue);
  }
}

function handleTimeout(currentTime) {
  // 这个函数的作用是检查timerQueue中的任务，如果有快过期的任务，将它
  // 放到taskQueue中，执行掉
  // 如果没有快过期的，并且taskQueue中没有任务，那就取出timerQueue中的
  // 第一个任务，等它的任务快过期了，执行掉它
  isHostTimeoutScheduled = false;
  // 检查过期任务队列中不应再被推迟的，放到taskQueue中
  advanceTimers(currentTime);

  if (!isHostCallbackScheduled) {
    if (peek(taskQueue) !== null) {
      // *如果 taskQueue 中还有任务时，不需要重新注册一个 setTimeout 处理 timerQueue；因为每一次在 workLoop 执行 taskQueue 中的任务之前，都回去检查 timerQueue 中的是否有已经“到时”的任务
      isHostCallbackScheduled = true;
      requestHostCallback(flushWork);
    } else {
      const firstTimer = peek(timerQueue);
      if (firstTimer !== null) {
        // !注意这里并没有将 isHostTimeoutScheduled 设置为 true；并不是 bug 而是开发团队有意为之，因为此时根本不需要设置为 true 了
        // !isHostTimeoutScheduled 的目的是为了防止请求多个 setTimeout；目前请求 setTimeout 的地方有三个 scheduleCallback, handleTimeout, workLoop 中；
        // !其中 handleTimeout 和 workLoop 都没有将 isHostTimeoutScheduled 设置为 true
        // !handleTimeout 就是 setTimeout 的回调函数；也就是说如果只请求了一个 setTimeout 那么就只会有一个 handleTimeout，如果只有一个 handleTimeout 那么 handleTimeout 内部也就只会请求一个 setTimeout；所以要从另外两个函数下手；
        // !在 workLoop 中当 taskQueue 为空，并且 timerQueue 不会空时将会请求一个 setTimeout；在 scheduleCallback 中如果 taskQueue 为空，并且 timerQueue 的堆顶等于 newTask 的话，会请求一个 setTimeout；
        // !假设 workLoop 中请求了一个 setTimeout，这个很好实现，在一个任务的回调中再调度一个延迟任务即可；此时我们只需要在 scheduleCallback 中再次请求一个 setTimeout 就可以证明这里的错误；
        // !我们分为两种情况使用 scheduleCallback
        // !1. 直接使用 scheduleCallback 此时在 scheduleCallback 中会将 isHostTimeoutScheduled 赋值为 true 防止请求多个 setTimeout
        // !2. 在 scheduleCallback 的回调中再进行调度；在回调中进行调度就相当于在 workLoop 中调用 scheduleCallback，而 workLoop 是执行完回调之后，再 taskQueue.pop() 的，所以此时的 taskQueue 是有值，在 scheduleCallback 中无法请求 setTimeout
        // !所以在 handleTimeout 和 workLoop 中无需将 isHostTimeoutScheduled 设置为 true；但是如果不会影响实际效果的话，我还是喜欢设置为 true 更容易理解一些
        requestHostTimeout(handleTimeout, firstTimer.startTime - currentTime);
      }
    }
  }
}

/**
 * @desc 在 reactV17.0.2 中，它可以看作是「调度任务」的起点，在它内部执行 workLoop
 * @param hasTimeRemaining
 * @param initialTime
 * @return {boolean}
 */
function flushWork(hasTimeRemaining, initialTime) {
  // ?这个 enableProfiling 经常看到，但是不知道有什么作用，可以默认为 true
  if (enableProfiling) {
    markSchedulerUnsuspended(initialTime);
  }

  // We'll need a host callback the next time work is scheduled.
  isHostCallbackScheduled = false;
  if (isHostTimeoutScheduled) {
    // We scheduled a timeout but it's no longer needed. Cancel it.
    isHostTimeoutScheduled = false;
    cancelHostTimeout();
  }

  isPerformingWork = true;// *标记为正在执行
  const previousPriorityLevel = currentPriorityLevel;
  try {
    if (enableProfiling) {
      try {
        return workLoop(hasTimeRemaining, initialTime);
      } catch (error) {
        if (currentTask !== null) {
          const currentTime = getCurrentTime();
          markTaskErrored(currentTask, currentTime);
          currentTask.isQueued = false;
        }
        throw error;
      }
    } else {
      // No catch in prod code path.
      return workLoop(hasTimeRemaining, initialTime);
    }
  } finally {
    currentTask = null;
    currentPriorityLevel = previousPriorityLevel;
    isPerformingWork = false;
    if (enableProfiling) {
      const currentTime = getCurrentTime();
      markSchedulerSuspended(currentTime);
    }
  }
}

function workLoop(hasTimeRemaining, initialTime) {
  let currentTime = initialTime;
  advanceTimers(currentTime);
  // 获取taskQueue中最紧急的任务
  currentTask = peek(taskQueue);
  while (
    currentTask !== null &&
    !(enableSchedulerDebugging && isSchedulerPaused)
  ) {
    if (
      currentTask.expirationTime > currentTime &&// 当前时间 < 过期时间 说明还没有过期
      (!hasTimeRemaining || shouldYieldToHost())// 没有剩余时间 或者 应该让出主线程
    ) {
      // This currentTask hasn't expired, and we've reached the deadline.
      // 当前任务没有过期，但是已经到了时间片的末尾，需要中断循环
      break;// *同样的，因为 taskQueue 也是一个最小堆，当堆顶都没有过期时，其他的也就都没有过期
    }
    const callback = currentTask.callback;
    if (typeof callback === 'function') {
      currentTask.callback = null;
      currentPriorityLevel = currentTask.priorityLevel;
      const didUserCallbackTimeout = currentTask.expirationTime <= currentTime;
      markTaskRun(currentTask, currentTime);
      const continuationCallback = callback(didUserCallbackTimeout);
      currentTime = getCurrentTime();
      if (typeof continuationCallback === 'function') {
        // 检查callback的执行结果返回的是不是函数，如果返回的是函数，则将这个函数作为当前任务新的回调。
        // *concurrent模式下，callback 是 performConcurrentWorkOnRoot，该函数内部根据当前调度的任务是否相同，来决定是否返回自身
        // *如果相同，则说明还有任务没做完，返回自身，其作为新的callback被放到当前的task上
        // *performConcurrentWorkOnRoot 每次 while循环完成一次之后，都会检查shouldYieldToHost
        // *如果需要让出执行权，则中断循环，走到下方，判断currentTask 是否 null 的地方，返回true，说明还有任务
        // *回到 performWorkUntilDeadline 中，判断还有任务，继续port.postMessage(null)，调用监听函数performWorkUntilDeadline，继续执行任务
        // performWorkConcurrentWorkOnRoot 在 ReactFiberWorkLoop.js 中
        currentTask.callback = continuationCallback;
        markTaskYield(currentTask, currentTime);
      } else {
        if (enableProfiling) {
          markTaskCompleted(currentTask, currentTime);
          currentTask.isQueued = false;
        }
        if (currentTask === peek(taskQueue)) {
          pop(taskQueue);
        }
      }
      advanceTimers(currentTime);
    } else {
      pop(taskQueue);
    }
    currentTask = peek(taskQueue);
  }
  // Return whether there's additional work
  // return 的结果会作为 performWorkUntilDeadline 中hasMoreWork的依据
  // 高优先级任务完成后，currentTask.callback为null，任务从taskQueue中删除，此时队列中还有低优先级任务，
  // currentTask = peek(taskQueue)  currentTask不为空，说明还有任务，继续postMessage执行workLoop，但它被取消过，导致currentTask.callback为null
  // 所以会被删除，此时的taskQueue为空，低优先级的任务重新调度，加入taskQueue
  if (currentTask !== null) {
    return true;
  } else {
    const firstTimer = peek(timerQueue);
    if (firstTimer !== null) {
      requestHostTimeout(handleTimeout, firstTimer.startTime - currentTime);
    }
    return false;
  }
}

function unstable_runWithPriority(priorityLevel, eventHandler) {
  switch (priorityLevel) {
    case ImmediatePriority:
    case UserBlockingPriority:
    case NormalPriority:
    case LowPriority:
    case IdlePriority:
      break;
    default:
      priorityLevel = NormalPriority;
  }

  var previousPriorityLevel = currentPriorityLevel;
  currentPriorityLevel = priorityLevel;

  try {
    return eventHandler();
  } finally {
    currentPriorityLevel = previousPriorityLevel;
  }
}

function unstable_next(eventHandler) {
  var priorityLevel;
  switch (currentPriorityLevel) {
    case ImmediatePriority:
    case UserBlockingPriority:
    case NormalPriority:
      // Shift down to normal priority
      priorityLevel = NormalPriority;
      break;
    default:
      // Anything lower than normal priority should remain at the current level.
      priorityLevel = currentPriorityLevel;
      break;
  }

  var previousPriorityLevel = currentPriorityLevel;
  currentPriorityLevel = priorityLevel;

  try {
    return eventHandler();
  } finally {
    currentPriorityLevel = previousPriorityLevel;
  }
}

function unstable_wrapCallback(callback) {
  var parentPriorityLevel = currentPriorityLevel;
  return function () {
    // This is a fork of runWithPriority, inlined for performance.
    var previousPriorityLevel = currentPriorityLevel;
    currentPriorityLevel = parentPriorityLevel;

    try {
      return callback.apply(this, arguments);
    } finally {
      currentPriorityLevel = previousPriorityLevel;
    }
  };
}

function unstable_scheduleCallback(priorityLevel, callback, options) {
  var currentTime = getCurrentTime();
  // 确定当前时间 startTime 和延迟更新时间 timeout
  var startTime;
  if (typeof options === 'object' && options !== null) {
    var delay = options.delay;
    if (typeof delay === 'number' && delay > 0) {
      startTime = currentTime + delay;
    } else {
      startTime = currentTime;
    }
  } else {
    startTime = currentTime;
  }

  var timeout;
  // *根据优先级，计算 timeout
  switch (priorityLevel) {
    case ImmediatePriority:
      timeout = IMMEDIATE_PRIORITY_TIMEOUT;
      break;
    case UserBlockingPriority:
      timeout = USER_BLOCKING_PRIORITY_TIMEOUT;
      break;
    case IdlePriority:
      timeout = IDLE_PRIORITY_TIMEOUT;
      break;
    case LowPriority:
      timeout = LOW_PRIORITY_TIMEOUT;
      break;
    case NormalPriority:
    default:
      timeout = NORMAL_PRIORITY_TIMEOUT;
      break;
  }

  var expirationTime = startTime + timeout;

  var newTask = {
    id: taskIdCounter++,
    // 任务本体
    callback,
    // 任务优先级
    priorityLevel,
    // 任务开始的时间，表示任务何时才能执行
    startTime,
    // 任务的过期时间
    expirationTime,
    // 在小顶堆队列中排序的依据
    sortIndex: -1,
  };
  if (enableProfiling) {
    newTask.isQueued = false;
  }
  // !如果是延迟任务则将 newTask 放入延迟调度队列（timerQueue）并执行 requestHostTimeout  timerQueue 是最小堆
  // !如果是正常任务则将 newTask 放入正常调度队列（taskQueue）并执行 requestHostCallback taskQueue 是最小堆

  if (startTime > currentTime) {// 开始时间 > 当前时间，说明该任务是一个延迟任务
    // This is a delayed task.
    newTask.sortIndex = startTime;// 对于延迟任务来说，sortIndex 是当前任务的开始时间
    push(timerQueue, newTask);
    if (peek(taskQueue) === null && newTask === peek(timerQueue)) {
      // All tasks are delayed, and this is the task with the earliest delay.
      if (isHostTimeoutScheduled) {
        // Cancel an existing timeout.
        cancelHostTimeout();
      } else {
        isHostTimeoutScheduled = true;
      }
      // Schedule a timeout.
      // 会把handleTimeout放到setTimeout里，在startTime - currentTime时间之后执行
      // 待会再调度
      requestHostTimeout(handleTimeout, startTime - currentTime);
    }
  } else {
    newTask.sortIndex = expirationTime;
    // taskQueue是最小堆，而堆内又是根据sortIndex（也就是expirationTime）进行排序的。
    // 可以保证优先级最高（expirationTime最小）的任务排在前面被优先处理。
    push(taskQueue, newTask);
    if (enableProfiling) {
      markTaskStart(newTask, currentTime);
      newTask.isQueued = true;
    }
    // Schedule a host callback, if needed. If we're already performing work,
    // wait until the next time we yield.
    // 调度一个主线程回调，如果已经执行了一个任务，等到下一次交还执行权的时候再执行回调。
    // 立即调度
    // *isHostCallbackScheduled 用于判断当前是否有已调度的回调任务，如果为 true 就说明有
    // *isPerformingWork 判断现在是否正在执行任务，因为「调度是异步的」
    if (!isHostCallbackScheduled && !isPerformingWork) {
      isHostCallbackScheduled = true;
      requestHostCallback(flushWork);
    }
  }

  return newTask;
}

function unstable_pauseExecution() {
  isSchedulerPaused = true;
}

function unstable_continueExecution() {
  isSchedulerPaused = false;
  if (!isHostCallbackScheduled && !isPerformingWork) {
    isHostCallbackScheduled = true;
    requestHostCallback(flushWork);
  }
}

function unstable_getFirstCallbackNode() {
  return peek(taskQueue);
}

function unstable_cancelCallback(task) {
  if (enableProfiling) {
    if (task.isQueued) {
      const currentTime = getCurrentTime();
      markTaskCanceled(task, currentTime);
      task.isQueued = false;
    }
  }

  // Null out the callback to indicate the task has been canceled. (Can't
  // remove from the queue because you can't remove arbitrary nodes from an
  // array based heap, only the first one.)
  // 不能从队列中删除这个任务，因为不能从基于堆的数组中删除任意节点，只能删除第一个节点。
  task.callback = null;
}

function unstable_getCurrentPriorityLevel() {
  return currentPriorityLevel;
}

const unstable_requestPaint = requestPaint;

export {
  ImmediatePriority as unstable_ImmediatePriority,
  UserBlockingPriority as unstable_UserBlockingPriority,
  NormalPriority as unstable_NormalPriority,
  IdlePriority as unstable_IdlePriority,
  LowPriority as unstable_LowPriority,
  unstable_runWithPriority,
  unstable_next,
  unstable_scheduleCallback,
  unstable_cancelCallback,
  unstable_wrapCallback,
  unstable_getCurrentPriorityLevel,
  shouldYieldToHost as unstable_shouldYield,
  unstable_requestPaint,
  unstable_continueExecution,
  unstable_pauseExecution,
  unstable_getFirstCallbackNode,
  getCurrentTime as unstable_now,
  forceFrameRate as unstable_forceFrameRate,
};

export const unstable_Profiling = enableProfiling
  ? {
    startLoggingProfilingEvents,
    stopLoggingProfilingEvents,
    sharedProfilingBuffer,
  }
  : null;
export {
  unstable_flushAllWithoutAsserting,
  unstable_flushNumberOfYields,
  unstable_flushExpired,
  unstable_clearYields,
  unstable_flushUntilNextPaint,
  unstable_flushAll,
  unstable_yieldValue,
  unstable_advanceTime
} from "./forks/SchedulerHostConfig.mock.js";

export {
  requestHostCallback,
  requestHostTimeout,
  cancelHostTimeout,
  shouldYieldToHost,
  getCurrentTime,
  forceFrameRate,
  requestPaint
} from "./forks/SchedulerHostConfig.default.js";
