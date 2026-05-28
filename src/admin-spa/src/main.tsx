import '@maxhub/max-ui/dist/styles.css';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { MaxUI } from '@maxhub/max-ui';
import { App } from './App';
import './styles.css';

// Точка входа SPA подключает официальную MAX UI-тему и наш корневой компонент.
// Вся прикладная логика дальше живёт в App и разложенных по папкам компонентах.
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <MaxUI>
      <App />
    </MaxUI>
  </React.StrictMode>
);
