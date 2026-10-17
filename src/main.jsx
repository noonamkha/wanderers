import { createRoot } from 'react-dom/client'
import { ConfigProvider } from 'antd'
import './index.css'
import App from './App.jsx'

createRoot(document.getElementById('root')).render(
    <ConfigProvider theme={{ token: { fontFamily: "'Noto Sans', 'Noto Color Emoji', sans-serif" } }}>
        <App />
    </ConfigProvider>
)
