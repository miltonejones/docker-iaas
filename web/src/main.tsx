import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { initSpotlight } from './spotlight';
import './styles.css';

initSpotlight();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
