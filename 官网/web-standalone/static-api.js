/* ============================================================================
 * static-api.js —— 静态数据适配层（web-standalone 专用，不依赖任何后端）
 *
 * web/ 原版页面把数据源硬编码为 '/functions/v1/app'（Qoder Sites 的
 * Supabase 后端，会消耗账号 PV 额度，额度用尽整站 429）。
 *
 * 本脚本在页面脚本之前加载，就地接管该路径的 GET 请求，改用同目录下的
 * data/content.json 应答。于是同一套页面：
 *   - 不需要 Qoder 后端
 *   - 不消耗任何额度
 *   - 可以丢到任意静态托管（或本地 http 服务）直接跑
 *
 * 字段映射逻辑与 dev/local-server.mjs 的 mockApi() 保持一致。
 * 写操作（POST）在纯静态托管下无处可写，统一返回 405 readonly_static_mode。
 * ========================================================================= */
(function () {
  'use strict';

  var API_PATH = '/functions/v1/app';
  var DATA_URL = 'data/content.json';
  var origFetch = window.fetch ? window.fetch.bind(window) : null;

  if (!origFetch) {
    console.error('[static-api] 当前环境没有 fetch，无法启用静态适配层');
    return;
  }

  var contentPromise = null;
  var loadFailed = null;

  function loadContent() {
    if (!contentPromise) {
      contentPromise = origFetch(DATA_URL, { cache: 'no-store' })
        .then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.json();
        })
        .catch(function (e) {
          loadFailed = e && e.message ? e.message : String(e);
          console.error('[static-api] 读取 ' + DATA_URL + ' 失败：' + loadFailed);
          showBanner();
          return {};
        });
    }
    return contentPromise;
  }

  function showBanner() {
    if (document.getElementById('static-api-error')) return;
    var box = document.createElement('div');
    box.id = 'static-api-error';
    box.style.cssText =
      'position:fixed;left:0;right:0;bottom:0;z-index:99999;padding:12px 16px;' +
      'background:#8a1f1f;color:#fff;font:14px/1.6 system-ui,"Microsoft YaHei",sans-serif;' +
      'text-align:center;box-shadow:0 -2px 12px rgba(0,0,0,.25)';
    box.textContent =
      '静态数据加载失败（' + (loadFailed || '未知错误') + '）。' +
      '请通过 http 服务打开本站，不要直接双击 html 文件。例如在目录下执行：python -m http.server 8080';
    (document.body || document.documentElement).appendChild(box);
  }

  function reply(body, status) {
    return new Response(JSON.stringify(body), {
      status: status || 200,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
    });
  }

  // ── content.json → API 响应体，字段名对齐 Supabase 表结构 ──────────────
  function mock(content, action, params) {
    var notices = (content.notices && content.notices.items) || [];
    var brands = (content.brands && content.brands.items) || [];
    var goods = (content.goods && content.goods.items) || [];
    var social = (content.social || []).filter(function (s) { return s.href; });

    function mapNotice(n) {
      return {
        id: n.id, date: n.date, type: n.type, style: n.style,
        summary: n.text || n.summary, title: n.title,
        cover: n.cover || '', cover_alt: n.coverAlt || n.cover_alt || '',
        // ↓ 注意：后端 getNotices 只 select 了列表字段、不带 body，而 notice.html
        //   的列表加载会把列表项写进 notices 缓存；点进详情时 showNotice() 命中缓存
        //   就不再请求详情 → 正文永远空白（web/ 原版就有这个 bug）。
        //   静态版直接把 body 带上，绕开它。
        body: n.body || []
      };
    }
    function mapBrand(b, i) {
      return { id: 'brand-' + i, name: b.name, sub: b.sub, logo: b.logo, is_self: b.isSelf || false };
    }
    function mapGood(g, i) {
      return {
        id: 'good-' + i, badge: g.badge, badge_style: g.badgeStyle, name: g.name,
        description: g.desc, image: g.image, image_alt: g.imageAlt, tags: g.tags,
        alt_label: g.alt, price: g.price, unit: g.unit,
        is_free: g.free || false, free_label: g.freeLabel || ''
      };
    }
    function mapEvent(e) {
      return e ? {
        badge: e.badge, title: e.title, subtitle: e.subtitle, booth: e.booth, debut: e.debut,
        date_start: e.date, date_end: e.dateEnd,
        link_label: e.linkLabel, link_href: e.link,
        visual: e.visual, visual_alt: e.visualAlt
      } : null;
    }
    function mapAbout(a) {
      if (!a) return null;
      return {
        badge: a.badge, title: a.title, subtitle: a.subtitle, paragraphs: a.paragraphs,
        identity_title: a.identityTitle, identity_tags: a.identityTags,
        biz_title: a.bizTitle, biz_tags: a.bizTags,
        visual: a.visual, visual_alt: a.visualAlt
      };
    }
    function mapSocial(s, i) {
      return { id: 'social-' + i, label: s.label, href: s.href, sub: s.sub };
    }
    // content.json 的 site / hero 是 camelCase，而真后端（Supabase 表）返回 snake_case。
    // 页面渲染代码只认后端那套命名，所以这里必须转，否则静态版与动态站行为分叉。
    function mapSite(s) {
      if (!s) return {};
      return {
        name: s.name, name_en: s.nameEn, short_name: s.shortName,
        slogan: s.slogan, slogan_en: s.sloganEn, logo: s.logo,
        theme_color: s.themeColor, worldview_note: s.worldviewNote,
        seo_title: s.seoTitle, seo_description: s.seoDescription, og_image: s.ogImage,
        footer_about: s.footerAbout, copyright: s.copyright, footer_note: s.footerNote,
        site_url: s.siteUrl || '', show_admin_entry: s.showAdminEntry
      };
    }
    function mapHero(h) {
      if (!h) return null;
      return {
        banner: h.banner, banner_fallback: h.bannerFallback, banner_alt: h.bannerAlt,
        badge: h.badge, title: h.title, body: h.body, sub: h.sub,
        actions: h.actions || [], stats: h.stats || []
      };
    }

    switch (action) {
      case 'all':
        return {
          ok: true,
          site: mapSite(content.site),
          hero: mapHero(content.hero),
          notices: notices.map(mapNotice),
          brands: brands.map(mapBrand),
          goods: goods.map(mapGood),
          event: mapEvent(content.event),
          social: social.map(mapSocial),
          about: mapAbout(content.about),
          shop: content.shop || null
        };

      case 'settings':
        return { ok: true, ...mapSite(content.site) };

      case 'hero':
        return { ok: true, ...(mapHero(content.hero) || {}) };

      case 'about':
        return { ok: true, ...(mapAbout(content.about) || {}) };

      case 'shop':
        return { ok: true, ...(content.shop || {}) };

      case 'notices':
        return { ok: true, items: notices.map(mapNotice) };

      case 'notice': {
        var id = params.get('id');
        for (var i = 0; i < notices.length; i++) {
          if (notices[i].id === id) {
            var n = notices[i];
            return {
              ok: true, ...n,
              summary: n.text || n.summary,
              cover_alt: n.coverAlt || n.cover_alt || '',
              body: n.body || []
            };
          }
        }
        return { error: 'not_found' };
      }

      case 'brands':
        return { ok: true, items: brands.map(mapBrand) };

      case 'goods':
        return { ok: true, items: goods.map(mapGood) };

      case 'events':
        return { ok: true, items: content.event ? [mapEvent(content.event)] : [] };

      case 'social':
        return { ok: true, items: social.map(mapSocial) };

      case 'list_images':
        return { error: 'storage_unavailable' };

      default:
        return { error: 'unknown_action' };
    }
  }

  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || '';

    if (url.indexOf(API_PATH) === -1) {
      return origFetch(input, init);
    }

    var method = ((init && init.method) || (input && input.method) || 'GET').toUpperCase();

    // 纯静态托管没有可写的地方：读操作照常，写操作明确报错，别假装成功
    if (method !== 'GET') {
      return Promise.resolve(reply({
        error: 'readonly_static_mode',
        message: '当前为静态演示模式，写入与登录不可用；需要后台请部署 functions/ 后端。'
      }, 405));
    }

    var action = new URL(url, location.href).searchParams.get('action');

    return loadContent().then(function (content) {
      var params = new URL(url, location.href).searchParams;
      var result = mock(content, action, params);
      if (result.error) {
        return reply({ error: result.error }, result.error === 'not_found' ? 404 : 503);
      }
      return reply(result, 200);
    });
  };

  // 让页面可以主动等待数据就绪（可选）
  window.staticApiReady = loadContent;
})();
