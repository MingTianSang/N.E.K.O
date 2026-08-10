import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { installChatFontPresetSync } from './chatFontPreset';
import './styles.css';

const rootElement = document.getElementById('root');

installChatFontPresetSync();

if (rootElement) {
  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}
