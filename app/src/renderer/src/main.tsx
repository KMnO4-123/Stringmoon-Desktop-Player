import { createRoot } from 'react-dom/client'
import App from './App'
import './styles/tokens.css'
import './styles/theme.css'
import './styles/player.css'
import './styles/listening.css'
import './styles/startup.css'

createRoot(document.getElementById('root')!).render(<App />)
