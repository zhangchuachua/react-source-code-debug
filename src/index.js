import React from 'react';
import ReactDOM from 'react-dom';
import { unstable_scheduleCallback } from 'scheduler';
import './index.css';
import App from './App';

const root = document.getElementById('root')

unstable_scheduleCallback(1, () => {
  console.log(1)

  unstable_scheduleCallback(1, () => {
    console.log(2)
  }, { delay: 200 })

  unstable_scheduleCallback(1, () => {
    console.log(3)
  }, { delay: 100 })
});


// Concurrent mode
// ReactDOM.createRoot(root).render(<App />);

// blocking mode
// ReactDOM.createBlockingRoot(root).render(<App />);

// Sync mode
ReactDOM.render(null, root);

console.log('React 源码调试，当前版本：' + React.version);
