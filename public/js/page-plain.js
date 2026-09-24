import { api, renderChrome, setFooterStatus } from './common.js';

renderChrome();
api('/api/current')
  .then((r) => setFooterStatus(r.election?.status ?? 'none'))
  .catch(() => setFooterStatus('none'));
