function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

export function markdownToSafeHtml(markdown = '') {
  let html = escapeHtml(markdown);
  html = html.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
  html = html.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');
  html = html.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
  html = html.replace(/~~([^~\n]+)~~/g, '<s>$1</s>');
  html = html.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+|mailto:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  html = html.replace(/(?:^|\n)((?:- .+(?:\n|$))+)/g, (_, block) => `<ul>${block.trim().split('\n').map((line) => `<li>${line.slice(2)}</li>`).join('')}</ul>`);
  html = html.replace(/(?:^|\n)((?:\d+\. .+(?:\n|$))+)/g, (_, block) => `<ol>${block.trim().split('\n').map((line) => `<li>${line.replace(/^\d+\.\s+/, '')}</li>`).join('')}</ol>`);
  return html.split(/\n{2,}/).map((block) => /^<(?:h\d|ul|ol|blockquote)/.test(block) ? block : `<p>${block.replace(/\n/g, '<br>')}</p>`).join('');
}

export function detailsText(item) {
  return String(item?.detailsMarkdown || '');
}

