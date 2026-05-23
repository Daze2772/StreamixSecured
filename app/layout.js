import './globals.css'
import { Inter } from 'next/font/google'

const inter = Inter({ subsets: ['latin'] })

export const metadata = {
  title: 'Streamix — Watch Movies & TV Shows',
  description: 'Stream unlimited movies and TV shows. Discover trending, popular, and top-rated content powered by TMDB.',
}

export default function RootLayout({ children }) {
  return (
    <html lang="en" className="dark">
      <head>
        <script dangerouslySetInnerHTML={{__html:`
          // Suppress noise from browser extensions (MetaMask, etc.) and PerformanceServerTiming clones
          window.addEventListener("error",function(e){
            var msg=(e&&e.message)||"";
            var src=(e&&e.filename)||"";
            if(src.indexOf("chrome-extension://")===0||src.indexOf("moz-extension://")===0){e.stopImmediatePropagation();e.preventDefault();return}
            if(msg.indexOf("MetaMask")!==-1||msg.indexOf("ethereum")!==-1){e.stopImmediatePropagation();e.preventDefault();return}
            if(e.error instanceof DOMException&&e.error.name==="DataCloneError"&&msg.indexOf("PerformanceServerTiming")!==-1){e.stopImmediatePropagation();e.preventDefault();return}
          },true);
          window.addEventListener("unhandledrejection",function(e){
            var reason=(e&&e.reason)||{};
            var msg=(reason&&(reason.message||String(reason)))||"";
            if(msg.indexOf("MetaMask")!==-1||msg.indexOf("Failed to connect to MetaMask")!==-1||msg.indexOf("ethereum")!==-1){e.preventDefault();return}
          },true);
        `}} />
      </head>
      <body className={`${inter.className} bg-black text-white antialiased overflow-x-hidden`}>
        {children}
      </body>
    </html>
  )
}
