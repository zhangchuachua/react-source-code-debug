import React, { useState, useMemo, useEffect } from "react";
import State from "./components/State";
import LanesDemo from "./components/LanesDemo";
import AppSibling from "./components/AppSibling";
import TasksWithDifferentPriorities from "./components/TasksWithDifferentPriorities";
import SchedulerTask from "./components/SchedulerTask";
import Concurrent from "./components/ConcurrentInput";
import Diff from "./components/Diff";
import PropsDiff from "./components/PropsDiff";
import Hooks from "./components/Hooks";
import EventDemo from "./components/EventDemo";
import ContextDemo from "./components/Context";
import "./App.css";

// propsDiff
/*class App extends React.Component {
  render() {
    return <PropsDiff/>
  }
}*/

function random255() {
  return Math.round(Math.random() * 255);
}

function CC() {
  const [count, setCount] = useState(0);

  const handleClick = useMemo(() => {
    return () => {
      setCount((prev) => {
        return prev + 1;
      });
    };
  }, []);

  useEffect(() => {
    const r = random255();
    const g = random255();
    const b = random255();
    document.body.style.backgroundColor = `rgb(${r}, ${g}, ${b})`;
  }, [count]);

  return (
    <div onClick={handleClick}>
      this is CC function component,{" "}
      <span style={{ color: "red" }}>{count}</span>
    </div>
  );
}

function App() {
  const [count, setCount] = useState(0);

  return (
    <main>
      <CC />
      <div>hello</div>
      <p>world</p>
    </main>
  );

  // 事件系统
  // return <EventDemo/>

  // return <Hooks/>
  // fiber树
  // return (
  //   <div className="App">
  //     <CC />
  //     <span className={'app-span'} onClick={() => setCount(count + 1)}>App{count}</span>
  //     <AppSibling count={count}/>
  //   </div>
  // );

  // Scheduler调度任务与用户交互
  // return <SchedulerTask/>

  // 高优先级插队
  // return <TasksWithDifferentPriorities/>

  // context
  // return <ContextDemo/>

  // diff 算法
  // return <Diff ref={'diffRef'}/>
}

export default App;
