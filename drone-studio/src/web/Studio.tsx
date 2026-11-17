import App from '../App';
import '../styles.css';

/** The existing 3D storyboard editor, mounted inside the hosted app with account-backed storage. */
export default function Studio({ storage }: { storage: Storage }) { return <div className="lu-studio"><App storage={storage} /></div>; }
