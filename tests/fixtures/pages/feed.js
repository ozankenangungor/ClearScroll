// Simulates an infinite-scroll SPA: posts are rendered client-side over time,
// and one post's text is edited in place after it appears.
const posts = [
  ["p1", "Just moved all my coins to a hardware wallet after the exchange paused withdrawals."],
  ["p2", "Our dog learned to open the back door by pulling the handle with his paw."],
  ["p3", "Ethereum and Solana tokens rallied after the exchange listed new staking products."],
  ["p4", "The ferry crossing took ninety minutes and the sea was perfectly calm."],
  ["p5", "Thunderstorms are expected across the region on Thursday afternoon."],
];
let i = 0;
const feed = document.getElementById("feed");
const timer = setInterval(() => {
  const [id, text] = posts[i++];
  const div = document.createElement("div");
  div.className = "post";
  div.innerHTML = `<p id="${id}"></p>`;
  div.firstChild.textContent = text;
  feed.append(div);
  if (i === posts.length) {
    clearInterval(timer);
    // In-place edit of an existing text node (characterData mutation).
    setTimeout(() => {
      document.getElementById("p5").firstChild.data = "Breaking: a stablecoin lost its peg and crypto markets are in turmoil.";
      document.body.dataset.feedDone = "1";
    }, 300);
  }
}, 150);
