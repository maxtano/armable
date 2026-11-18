import { createRoot } from 'react-dom/client';
import '../design-system/tokens.css';
import '../web/web.css';
import '../web/instruments.css';
import './panel.css';
import { Panel } from './Panel';

createRoot(document.getElementById('root')!).render(<Panel />);
