// Facebook Pixel Integration with Influencer suppression
(function() {
    try {
        var userType = localStorage.getItem('30win_user_type');
        if (userType === 'influencer') {
            console.log('[Pixel] Influencer account detected, Pixel suppressed.');
            return;
        }

        // Initialize Meta Pixel
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
        
        // Add noscript element
        var noscript = document.createElement('noscript');
        var img = document.createElement('img');
        img.height = 1;
        img.width = 1;
        img.style.display = 'none';
        img.src = 'https://www.facebook.com/tr?id=1518053683231214&ev=PageView&noscript=1';
        noscript.appendChild(img);
        document.head.appendChild(noscript);
        
        console.log('[Pixel] Tracked PageView');
    } catch(err) {
        console.error('[Pixel] Init error', err);
    }
})();
