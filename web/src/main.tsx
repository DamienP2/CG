import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';
import { loadFonts } from './engine/fonts';

// Server fonts for every page (designer, operator, HTML5 outputs, plugins).
void loadFonts();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
