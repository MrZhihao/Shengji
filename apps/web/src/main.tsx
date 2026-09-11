import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import './styles.css';
import { setupPwa } from './pwa.ts';
import { preloadSounds } from './sound.ts';

setupPwa();
window.addEventListener('pointerdown', () => preloadSounds(), { once: true });

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
