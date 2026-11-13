/* Evaluated inside real WKWebView after the emitted page has loaded. It reads
 * the canvas back with getImageData, hashes those pixels, and collects DOM
 * roles/computed styles from the live page. The result is base64 JSON; the
 * Node wrapper decodes it with the same fact parser used for Chromium. */

(() => {
  'use strict';
  const meta = document.getElementById('opurom-verify');
  if (!meta || meta.getAttribute('data-ready') !== '1') {
    throw new Error('page facts are not ready');
  }
  const canvas = document.getElementById('fx');
  const context = canvas.getContext('2d');
  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (let i = 0; i < image.data.length; i += 1) {
    hash = BigInt.asUintN(64, hash ^ BigInt(image.data[i]));
    hash = BigInt.asUintN(64, hash * prime);
  }
  const digest = hash.toString(16).padStart(16, '0');

  const pageFacts = JSON.parse(atob(meta.getAttribute('data-result')));
  if (pageFacts.digest !== digest) {
    throw new Error(`page digest ${pageFacts.digest} differs from getImageData digest ${digest}`);
  }

  function computed(element, property) {
    return element ? window.getComputedStyle(element).getPropertyValue(property) : null;
  }
  const roles = Array.from(document.querySelectorAll('[data-node-id]')).map((element) => ({
    id: Number(element.getAttribute('data-node-id')),
    tag: element.tagName.toLowerCase(),
    role: element.getAttribute('role')
  }));
  const button = document.querySelector('button');
  const heading = document.querySelector('[role="heading"]');
  const styles = {
    headerDisplay: computed(document.querySelector('header'), 'display'),
    mainDisplay: computed(document.querySelector('main'), 'display'),
    canvasDisplay: computed(canvas, 'display'),
    buttonDisplay: button ? computed(button, 'display') : null,
    buttonBackground: button ? computed(button, 'background-color') : null,
    headingFontSize: heading ? window.getComputedStyle(heading).fontSize : null
  };
  const facts = {
    digest,
    canvas: { width: canvas.width, height: canvas.height },
    roles,
    styles,
    pageDigest: pageFacts.digest
  };
  return btoa(JSON.stringify(facts));
})()
