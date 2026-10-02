import test from 'node:test';
import assert from 'node:assert/strict';
import { floatingSubmitVisible, clampPosition, initFloatingSubmit, initTheme } from '../src/utils/site-controls.ts';

function fixture({path='/', storageFails=false, saved={}, dark=false}={}) {
  const originals = new Map();
  const install = (key, value) => { originals.set(key, Object.getOwnPropertyDescriptor(globalThis,key)); Object.defineProperty(globalThis,key,{value,configurable:true,writable:true}); };
  class Node {
    handlers = new Map(); attributes = {}; dataset = {}; style = {}; hidden = true; textContent='';
    addEventListener(type, handler) { const list=this.handlers.get(type)||[]; list.push(handler); this.handlers.set(type,list); }
    fire(type, overrides={}) { const event={button:0,isPrimary:true,pointerId:1,clientX:310,clientY:710,detail:1,defaultPrevented:false,preventDefault(){this.defaultPrevented=true;},...overrides}; for (const handler of this.handlers.get(type)||[]) handler(event); return event; }
    setAttribute(name,value) { this.attributes[name]=value; }
    querySelector() { return label; }
    setPointerCapture() {}
    getBoundingClientRect() { const x=Number.parseFloat(this.style.left)||250,y=Number.parseFloat(this.style.top)||700; return {x,y,top:y,width:128,height:48}; }
  }
  const link=new Node(), button=new Node(),label=new Node(),meta=new Node(),root=new Node(),win=new Node(),media=new Node();
  media.matches=dark; root.dataset.theme=dark?'dark':'light';
  const nav={getBoundingClientRect:()=>({top:720,height:68})};
  const values=new Map(Object.entries(saved));
  install('localStorage',{getItem(key){if(storageFails)throw Error('blocked');return values.get(key)||null;},setItem(key,value){if(storageFails)throw Error('blocked');values.set(key,value);}});
  install('location',{pathname:path});install('innerWidth',390);install('innerHeight',800);
  install('document',{documentElement:root,querySelector(selector){return {'.floating-submit':link,'.bottom-nav':nav,'.theme-toggle':button,'meta[name="theme-color"]':meta}[selector];}});
  install('window',win);install('matchMedia',()=>media);
  return {link,button,label,meta,root,win,media,values,restore(){for(const [key,descriptor] of originals) { if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key]; }}};
}

test('floating contribution only appears on discovery pages, including dynamic detail URLs',()=>{
  for (const path of ['/','/foods/','/foods/example/','/restaurants/example/','/search/','/live-detail/']) assert.equal(floatingSubmitVisible(path),true,path);
  for (const path of ['/submit/','/status/','/admin/','/about/','/foodstuff/']) assert.equal(floatingSubmitVisible(path),false,path);
});

test('drag ends without navigation, stays above mobile navigation and retains its position',()=>{
  const f=fixture();try {
    initFloatingSubmit();assert.equal(f.link.hidden,false);
    f.link.fire('pointerdown'); f.link.fire('pointermove',{clientX:900,clientY:1000});f.link.fire('pointerup');
    assert.equal(f.link.fire('click').defaultPrevented,true);
    assert.deepEqual(JSON.parse(f.values.get('shou-submit-position')),{x:250,y:660});
    assert.equal(f.link.dataset.dragging,undefined);
    f.link.fire('pointerdown'); f.link.fire('pointerup');
    assert.equal(f.link.fire('click').defaultPrevented,false,'a following tap must navigate');
  } finally { f.restore(); }
});

test('small finger motion is a click; another pointer cannot move the button',()=>{
  const f=fixture();try {
    initFloatingSubmit();f.link.fire('pointerdown');
    f.link.fire('pointermove',{pointerId:2,clientX:50,clientY:50});f.link.fire('pointerup',{pointerId:2});
    f.link.fire('pointermove',{clientX:312,clientY:711});f.link.fire('pointerup');
    assert.equal(f.link.fire('click').defaultPrevented,false);assert.equal(f.values.has('shou-submit-position'),false);
  } finally { f.restore(); }
});

test('cancellation, corrupt storage and denied storage leave keyboard navigation usable',()=>{
  for(const options of [{storageFails:true},{saved:{'shou-submit-position':'not-json'}}]) {
    const f=fixture(options);try {
      initFloatingSubmit();f.link.fire('pointerdown');f.link.fire('pointermove',{clientX:10,clientY:10});f.link.fire('pointercancel');
      assert.equal(f.link.dataset.dragging,undefined);
      const move=f.link.fire('keydown',{key:'ArrowLeft'});assert.equal(move.defaultPrevented,true);
      assert.equal(f.link.fire('click',{detail:0}).defaultPrevented,false,'Enter activation still works');
    } finally { f.restore(); }
  }
});

test('resizing restores saved positions inside the viewport and away from the bottom bar',()=>{
  const f=fixture({saved:{'shou-submit-position':JSON.stringify({x:1900,y:1200})}});try {
    initFloatingSubmit();assert.equal(f.link.style.left,'250px');assert.equal(f.link.style.top,'660px');
    globalThis.innerWidth=320;f.win.fire('resize');assert.equal(f.link.style.left,'180px');
    assert.deepEqual(clampPosition(-100,-100,128,48,320,640,80),{x:12,y:12});
  } finally { f.restore(); }
});

test('theme follows the system until a choice is made and works with blocked storage',()=>{
  for (const storageFails of [false,true]) {
    const f=fixture({storageFails});try {
      initTheme();f.media.matches=true;f.media.fire('change');assert.equal(f.root.dataset.theme,'dark');
      f.button.fire('click');assert.equal(f.root.dataset.theme,'light');assert.equal(f.button.attributes['aria-label'],'切换到黑夜模式');
      f.media.fire('change');assert.equal(f.root.dataset.theme,'light');assert.equal(f.meta.attributes.content,'#fbf9f6');
    } finally { f.restore(); }
  }
});

test('explicit theme survives system changes; another tab can update or clear the preference',()=>{
  const f=fixture({saved:{'shou-theme':'dark'},dark:true});try {
    initTheme();f.media.matches=false;f.media.fire('change');assert.equal(f.root.dataset.theme,'dark');
    f.win.fire('storage',{key:'shou-theme',newValue:'light'});assert.equal(f.root.dataset.theme,'light');
    f.media.matches=true;f.win.fire('storage',{key:'shou-theme',newValue:null});assert.equal(f.root.dataset.theme,'dark');
  } finally { f.restore(); }
});
