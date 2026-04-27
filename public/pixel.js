// Facebook Pixel Integration
(function() {
    try {
        // Pixel Turbo - Captura de Alma Digital ativada para todas as contas no teste
        console.log('[Pixel] Initializing FB Pixel...');

        // Meta Pixel Code
        !function(f,b,e,v,n,t,s)
        {if(f.fbq)return;n=f.fbq=function(){n.callMethod?
        n.callMethod.apply(n,arguments):n.queue.push(arguments)};
        if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';
        n.queue=[];t=b.createElement(e);t.async=!0;
        t.src=v;s=b.getElementsByTagName(e)[0];
        s.parentNode.insertBefore(t,s)}(window, document,'script',
        'https://connect.facebook.net/en_US/fbevents.js');
        
        fbq('init', '1518053683231214');
        fbq('track', 'PageView');

        // Add noscript fallback
        var noscript = document.createElement('noscript');
        var img = document.createElement('img');
        img.height = "1";
        img.width = "1";
        img.style.display = "none";
        img.src = "https://www.facebook.com/tr?id=1518053683231214&ev=PageView&noscript=1";
        noscript.appendChild(img);
        document.head.appendChild(noscript);
        
        console.log('[Pixel] Tracked PageView for ID: 1518053683231214');
    } catch(err) {
        console.error('[Pixel] Init error', err);
    }
})();
