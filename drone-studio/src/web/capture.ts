/** Render the drone diagram to a PNG so an assistant can look at it. Only the SVG is captured; nothing else on the page. */
export async function captureView(_view: string): Promise<{ png?: string; note?: string }> {
  const svg = document.querySelector<SVGSVGElement>('svg[data-capture="drone"]');
  if (!svg) return { note: 'The drone view is not on screen. Ask the person to open it, or use read.' };
  const clone = svg.cloneNode(true) as SVGSVGElement;
  const style = getComputedStyle(document.documentElement);
  // Inline the colours the stylesheet would have supplied.
  const css = [...document.styleSheets].flatMap(sheet => { try { return [...sheet.cssRules].map(r => r.cssText); } catch { return []; } }).filter(t => t.includes('.dg-') || t.startsWith(':root')).join('\n');
  const node = document.createElementNS('http://www.w3.org/2000/svg', 'style');
  node.textContent = css;
  clone.insertBefore(node, clone.firstChild);
  clone.setAttribute('width', '1000'); clone.setAttribute('height', '700');
  clone.style.background = style.getPropertyValue('--ds-bg') || '#161819';
  const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(clone)], { type: 'image/svg+xml' }));
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => { image.onload = () => resolve(); image.onerror = () => reject(new Error('render failed')); image.src = url; });
    const canvas = document.createElement('canvas');
    canvas.width = 1000; canvas.height = 700;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = style.getPropertyValue('--ds-bg') || '#161819';
    ctx.fillRect(0, 0, 1000, 700);
    ctx.drawImage(image, 0, 0, 1000, 700);
    return { png: canvas.toDataURL('image/png').split(',')[1] };
  } catch { return { note: 'The view could not be rendered to an image.' }; }
  finally { URL.revokeObjectURL(url); }
}
