// A post component with a shadow root: the layout and the vote/comment row
// live in the shadow tree; title, thumbnail and body are slotted from the
// light DOM, which is where the page's own text is.
customElements.define(
  "social-post",
  class extends HTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: "open" }).innerHTML = `
        <style>
          .card { background: #fff; border-radius: 10px; padding: 10px; }
          ::slotted([slot="title"]) { display: block; font-weight: 600; font-size: 15px; color: #111; text-decoration: none; }
          ::slotted(img) { width: 100%; height: 150px; border-radius: 8px; display: block; margin: 6px 0; }
          .bar { color: #777; font-size: 12px; }
        </style>
        <div class="card">
          <slot name="title"></slot>
          <slot name="thumbnail"></slot>
          <slot name="body"></slot>
          <div class="bar">▲ 1.4k · 212 comments · Share</div>
        </div>`;
    }
  }
);
