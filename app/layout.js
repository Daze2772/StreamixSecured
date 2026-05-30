import './globals.css'
import { Inter } from 'next/font/google'
import { DevToolsDeterrent } from '@/components/streamix/DevToolsDeterrent'

const inter = Inter({ subsets: ['latin'] })

export const metadata = {
  title: 'Streamix — Watch Movies & TV Shows',
  description: 'Stream unlimited movies and TV shows. Discover trending, popular, and top-rated content powered by TMDB.',
}

// `viewport-fit=cover` is REQUIRED for iOS Safari to expose the
// `env(safe-area-inset-*)` CSS variables. Without it those return 0,
// which causes the rightmost player control (fullscreen) to be clipped
// under the iPhone notch in landscape on devices with a Dynamic Island.
export const viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#000000',
}

export default function RootLayout({ children }) {
  return (
    <html lang="en" className="dark">
      <head>
        <script dangerouslySetInnerHTML={{__html:`
(function(){
  // Filter browser-extension noise (MetaMask, wallet injects) from EVERY error/rejection listener
  // — including Next.js dev overlay's own listener.
  function isExtNoise(e){
    try{
      var src = (e && e.filename) || "";
      var reason = (e && e.reason) || {};
      var msg = (e && e.message) || (reason && (reason.message || (typeof reason==="string"?reason:""))) || "";
      var stack = (e && e.error && e.error.stack) || (reason && reason.stack) || "";
      if (src.indexOf("chrome-extension://")===0) return true;
      if (src.indexOf("moz-extension://")===0) return true;
      if (stack.indexOf("chrome-extension://")!==-1) return true;
      if (msg.indexOf("MetaMask")!==-1) return true;
      if (msg.indexOf("Failed to connect to MetaMask")!==-1) return true;
      if (msg.indexOf("ethereum")!==-1) return true;
      if (e && e.error instanceof DOMException && e.error.name==="DataCloneError" && msg.indexOf("PerformanceServerTiming")!==-1) return true;
    }catch(_){}
    return false;
  }
  var origAdd = window.addEventListener;
  window.addEventListener = function(type, listener, options){
    if ((type === "error" || type === "unhandledrejection") && typeof listener === "function"){
      var wrapped = function(e){
        if (isExtNoise(e)) { try{ e.stopImmediatePropagation && e.stopImmediatePropagation(); e.preventDefault && e.preventDefault(); }catch(_){ } return; }
        return listener.apply(this, arguments);
      };
      try { listener.__wrapped = wrapped; } catch(_){}
      return origAdd.call(this, type, wrapped, options);
    }
    return origAdd.call(this, type, listener, options);
  };
  // Our own top-level guards
  origAdd.call(window, "error", function(e){ if(isExtNoise(e)){ e.stopImmediatePropagation(); e.preventDefault(); } }, true);
  origAdd.call(window, "unhandledrejection", function(e){ if(isExtNoise(e)){ e.preventDefault(); } }, true);
})();
        `}} />
      </head>
      <body className={`${inter.className} bg-black text-white antialiased overflow-x-hidden`}>
        <DevToolsDeterrent />
        {children}
      </body>
    </html>
  )
}
