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

/* 移动端菜单的收尾行为（四页共用，别往单页里再抄一份）
 *
 * 各页原本只绑了 navToggle 的开关。手机上展开菜单后，点页面任何地方
 * 都不会收起，菜单一直盖着内容，得再去找右上角那个按钮 —— 这是
 * 「手机上不好用」里最直接的一条。
 *
 * 这里只补「点外面 / 按 Esc 就收起」，不碰展开逻辑，
 * 避免和每页已有的 toggle 处理打架。
 */
(function () {
  var toggle = document.getElementById('navToggle');
  var nav = document.getElementById('mainNav');
  if (!toggle || !nav) return;

  function close() {
    if (!nav.classList.contains('is-open')) return;
    nav.classList.remove('is-open');
    toggle.setAttribute('aria-expanded', 'false');
  }

  // 点导航里的链接：同页锚点不会刷新页面，得手动收
  nav.addEventListener('click', function (e) {
    if (e.target.closest('a')) close();
  });

  // 点菜单以外的任何地方
  document.addEventListener('click', function (e) {
    if (e.target.closest('#navToggle') || e.target.closest('#mainNav')) return;
    close();
  });

  // 手机上接外接键盘 / 平板带键盘的情况
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') close();
  });
})();
