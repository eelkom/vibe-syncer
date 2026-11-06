// Serialized by Playwright. Observe only: no player commands, property setters,
// API interception, history wrapping, or YouTube postMessage requests.
export function joinTimelineProbe({ youtube }) {
  const report = (name, extra = {}) => console.debug('__join_timeline ' + JSON.stringify({ name, t: Date.now(), ...extra }));
  const isYouTube = value => {
    try {
      const host = new URL(value).hostname;
      return ['youtube.com', 'youtube-nocookie.com'].some(domain => host === domain || host.endsWith(`.${domain}`));
    } catch { return false; }
  };
  if (window.top !== window) {
    if (!youtube || !isYouTube(window.location.href) || !window.location.pathname.startsWith('/embed/')) return;
    for (const [event, name] of [['seeking', 'first_seek_start'], ['seeked', 'first_seek_end'], ['playing', 'first_playing']]) {
      document.addEventListener(event, e => {
        if (e.target?.tagName === 'VIDEO') report(name, {
          ct: e.target.currentTime, ad: !!document.querySelector('.html5-video-player.ad-showing'),
        });
      }, true);
    }
    return;
  }
  document.addEventListener('click', event => {
    const button = event.target?.closest?.('button[type="submit"]');
    if (event.isTrusted && button?.form?.querySelector('#roomCode')) report('join_click');
  }, true);
  let routed = false, mounted = false;
  const inspect = () => {
    if (!routed && window.location.pathname.startsWith('/room/')) {
      routed = true;
      report('room_route', { url: window.location.href });
    }
    if (!mounted) {
      const found = youtube
        ? [...document.querySelectorAll('iframe')].some(el => isYouTube(el.src))
        : !!document.querySelector('audio,video');
      if (found) { mounted = true; report('player_mount'); }
    }
  };
  window.navigation?.addEventListener('currententrychange', inspect);
  window.addEventListener('popstate', inspect);
  new MutationObserver(inspect).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
  inspect();
  if (youtube) {
    window.addEventListener('message', event => {
      if (!isYouTube(event.origin)) return;
      let data = event.data;
      try { if (typeof data === 'string') data = JSON.parse(data); } catch { return; }
      if (data?.event === 'onReady') report('player_ready', { origin: event.origin });
    });
  } else {
    for (const [event, name] of [['loadedmetadata', 'player_ready'], ['seeking', 'first_seek_start'],
      ['seeked', 'first_seek_end'], ['playing', 'first_playing']]) {
      document.addEventListener(event, e => {
        if (e.target?.matches?.('audio,video')) report(name, { ct: e.target.currentTime });
      }, true);
    }
  }
}
