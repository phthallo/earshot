import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { SpacetimeDBProvider } from 'spacetimedb/react';
import { connectionBuilder } from './stdb';
import { App } from './App';
import './styles.css';

// Links saved before every page lived under /venues: ?view=admin[&venue=x] was the venues page
// and /map[?view=me|privacy] the Cal Hacks map. The rest of the query (floor, zone, device) stays.
const legacy = new URLSearchParams(location.search);
const view = legacy.get('view');
if (view === 'admin') {
  const venue = legacy.get('venue');
  history.replaceState(null, '', venue ? `/venues/${encodeURIComponent(venue)}` : '/venues');
} else if (location.pathname === '/map' || location.pathname === '/map/') {
  legacy.delete('view');
  const qs = legacy.toString();
  history.replaceState(null, '', `/venues/calhacks${view === 'me' || view === 'privacy' ? `/${view}` : ''}${qs ? `?${qs}` : ''}`);
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <SpacetimeDBProvider connectionBuilder={connectionBuilder()}>
      <App />
    </SpacetimeDBProvider>
  </StrictMode>,
);
