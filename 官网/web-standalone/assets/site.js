/* 站点设置应用层（index / goods / notice / recruitment 四页共用）
 *
 * 从 /functions/v1/app?action=settings 取站点设置，用**精确选择器**覆盖页面上
 * 写死的顶栏、页脚、世界观察条与 SEO 元信息。刻意不新增 id/class：
 * 接口挂了、没数据、没 JS 时，静态 HTML 原样保留 —— 这就是兜底。
 *
 * 之所以抽成独立文件而不是每页抄一份：这段逻辑要跟着「站点设置」这个 tab 走，
 * 抄四份迟早会有一份忘记改（goods.html 原本就只有它自己那份硬编码页脚）。
 */
(function () {
  var API = '/functions/v1/app';

  function esc(s) {
    var d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }
  function q(sel) { return document.querySelector(sel); }
  function setText(sel, val) { var el = q(sel); if (el && val) el.textContent = val; }
  function setAttr(sel, attr, val) { var el = q(sel); if (el && val) el.setAttribute(attr, val); }

  fetch(API + '?action=settings', { credentials: 'same-origin' })
    .then(function (r) { return r.json(); })
    .then(function (st) {
      if (!st || !st.ok) return;

      // ── SEO / 元信息 ──
      if (st.seo_title) document.title = st.seo_title;
      setAttr('meta[name="description"]', 'content', st.seo_description);
      setAttr('meta[name="theme-color"]', 'content', st.theme_color);
      setAttr('meta[property="og:image"]', 'content', st.og_image);

      // ── 顶栏 ──
      setText('.site-header .logo span', st.name);
      if (st.logo) setAttr('.site-header .logo img', 'src', st.logo);

      // ── 世界观察条（架空设定声明）──
      setText('.world-bar p', st.worldview_note);

      // ── 页脚 ──
      setText('.footer-brand .logo span', st.name);
      if (st.logo) setAttr('.footer-brand .logo img', 'src', st.logo);
      setText('.footer-brand > p:not(.footer-slogan)', st.footer_about);
      var fs = q('.footer-slogan');
      if (fs && (st.slogan || st.slogan_en)) {
        fs.innerHTML = esc(st.slogan || '') +
          (st.slogan_en ? '<em>' + esc(st.slogan_en) + '</em>' : '');
      }
      setText('.footer-bottom span:first-child', st.copyright);
      setText('.footer-bottom span:last-child', st.footer_note);

      // ── 后台入口开关 ──
      // 库里存的是字符串 "true"/"false"，content.json 里是布尔，两种都认
      var adminEntry = q('.admin-entry');
      if (adminEntry) {
        var hide = st.show_admin_entry === false ||
          String(st.show_admin_entry).toLowerCase() === 'false';
        adminEntry.style.display = hide ? 'none' : '';
      }
    })
    .catch(function () { /* 静态内容兜底 */ });
})();
