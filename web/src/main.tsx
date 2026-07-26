import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { AuthProvider } from './AuthContext';
import { ConfirmProvider } from './components/ConfirmContext';
import { ToastProvider } from './ToastContext';
import { ThemeProvider } from './contexts/ThemeContext';
import { initSpotlight } from './spotlight';
import './styles.css';
import './themes/dark.css';
import './themes/glass.css';
import './themes/material.css';
import './themes/illustrated.css';

initSpotlight();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ThemeProvider>
      <ToastProvider>
        <AuthProvider>
          <ConfirmProvider>
            <App />
          </ConfirmProvider>
        </AuthProvider>
      </ToastProvider>
    </ThemeProvider>
  </React.StrictMode>,
);
