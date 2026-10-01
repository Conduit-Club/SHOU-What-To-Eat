import { turnstileWidget, resetTurnstile } from './turnstile-client';
import { compressReviewImage } from './review-submission';
import { SUBMISSION_LIMITS as LIMITS, parseYuan, splitTags } from '../lib/submission-limits';
import { validateV2Submission, V2ValidationError } from '../worker/v2-validation';
import { clearFormErrors, formProblems, notifyForm, showFormErrors } from './form-feedback';

type EntityType = 'venue' | 'food';
type Photo = { blob: Blob; url: string; alt: string };
type Receipt = { submissionId: string; receiptToken: string; version: number; type: EntityType; expectedImages: number; expectedReviewImages: number; entityId?: string };
class SubmissionError extends Error { constructor(message: string, readonly code: string, readonly status: number) { super(message); } }
export function initSubmissionForm() {
  const form = document.querySelector<HTMLFormElement>('#submission-form');
  if (!form) return;
  const activeForm = form;
  const field = (name: string) => activeForm.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
  const value = (name: string) => field(name).value.trim();
  const checked = (name: string) => (field(name) as HTMLInputElement).checked;
  const currentType = (): EntityType => form.querySelector<HTMLInputElement>('input[name=entityType]:checked')!.value as EntityType;
  const photos: Record<'entity' | 'attachedReview', Photo[]> = { entity: [], attachedReview: [] };
  const lists = { entity: form.querySelector<HTMLElement>('#entity-previews')!, attachedReview: form.querySelector<HTMLElement>('#review-previews')! };
  const submit = form.querySelector<HTMLButtonElement>('button[type=submit]')!;
  const retry = form.querySelector<HTMLButtonElement>('#retry-submission')!;
  const feedback = form.querySelector<HTMLElement>('.feedback')!;
  const pendingKey = 'shou-pending-submission-v2';
  const historyKey = 'shou-submission-receipts-v2';
  const read = (key: string) => { try { return sessionStorage.getItem(key); } catch { return null; } };
  const write = (key: string, data: unknown) => { try { sessionStorage.setItem(key, JSON.stringify(data)); } catch { /* The visible receipt remains usable when storage is disabled. */ } };
  let pending: Receipt | null = null;
  let attempt: { key: string; fingerprint: string } | null = null;
  let busy = false;
  const message = (text: string, tone: 'info' | 'error' | 'success' = 'info') => { feedback.textContent = text; feedback.dataset.tone = tone; if (tone !== 'info') notifyForm(text,tone); };
  const enableSection = (root: HTMLElement, enabled: boolean) => root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input,select,textarea').forEach(control => { control.disabled = !enabled || busy; });
  function syncFields() {
    const type = currentType();
    form!.querySelector<HTMLElement>('[data-photo-count=entity-images]')!.textContent = photos.entity.length ? `已选 ${photos.entity.length} 张，首张作为默认封面。` : type==='food' ? '必填：至少一张这道餐品的实拍照片。' : '选填：推荐门头或窗口实拍，方便同学找到。';
    form!.querySelector<HTMLElement>('[data-entity-photo-required]')!.hidden = type !== 'food';
    for (const kind of ['venue','food']) { const root = form!.querySelector<HTMLElement>(`#${kind}-fields`)!; root.hidden = kind !== type; enableSection(root,kind === type); }
    const offCampus = type === 'venue' && value('venueCategory') === 'off-campus';
    const distances = form!.querySelector<HTMLElement>('#distance-fields')!; distances.hidden = !offCampus; enableSection(distances,offCampus);
    field('venueDistanceBasis').required = offCampus && Boolean(value('venueDistanceMeters'));
    form!.querySelector<HTMLElement>('[data-distance-required]')!.hidden = !field('venueDistanceBasis').required;
    for (const kind of ['venue','food']) { field(kind+'PriceSource').required = kind === type && Boolean(value(kind+'Price')); form!.querySelector<HTMLElement>(`[data-price-required=${kind}]`)!.hidden = !field(kind+'PriceSource').required; }
    const hasPhotos = photos.entity.length + photos.attachedReview.length > 0;
    const metadata = form!.querySelector<HTMLElement>('#image-metadata')!; metadata.hidden = !hasPhotos; enableSection(metadata,hasPhotos);
    const licensed = hasPhotos && value('photoOrigin') === 'licensed';
    const external = form!.querySelector<HTMLElement>('#external-rights')!; external.hidden = !licensed; enableSection(external,licensed);
    for (const name of ['imageSource','imageHolder','imageLicense']) field(name).required = licensed;
    field('rightsConfirmed').required = hasPhotos;
    form!.querySelector('[data-rights-label]')!.textContent = licensed ? '我确认已获得相应使用权，并授权本站按所填许可展示。' : '这些照片由本人拍摄，我授权本站展示，并可选作对应餐品或店铺的封面。';
    submit.disabled = busy || !widget || Boolean(pending);
    retry.disabled = busy;
  }
  function setBusy(next: boolean) {
    busy = next;
    form!.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement | HTMLTextAreaElement>('input,button,select,textarea').forEach(control => { control.disabled = next; });
    syncFields();
  }
  function showReceipt(receipt: Receipt, complete = true) {
    const panel = document.querySelector<HTMLElement>('#receipt-panel')!;
    const records = (() => { try { const data = JSON.parse(read(historyKey) ?? '{}'); return data && typeof data === 'object' && !Array.isArray(data) ? data : {}; } catch { return {}; } })();
    records[receipt.submissionId] = receipt; write(historyKey,records);
    panel.hidden = false;
    panel.querySelector('h2')!.textContent = complete ? '投稿已收到，保存好这份回执' : '资料已保存，请继续完成图片上传';
    document.querySelector<HTMLInputElement>('#receipt-id')!.value = receipt.submissionId;
    document.querySelector<HTMLInputElement>('#receipt-entity-id')!.value = receipt.entityId ?? '';
    document.querySelector<HTMLElement>('#receipt-entity-row')!.hidden = !receipt.entityId;
    document.querySelector<HTMLInputElement>('#receipt-token')!.value = receipt.receiptToken;
    document.querySelector<HTMLInputElement>('#receipt-token')!.type = 'password';
    document.querySelector<HTMLButtonElement>('#receipt-token-toggle')!.textContent = '显示';
    document.querySelector<HTMLAnchorElement>('#receipt-status-link')!.href = '/status/?id='+encodeURIComponent(receipt.submissionId);
    const add = document.querySelector<HTMLAnchorElement>('#receipt-food-link')!; add.hidden = receipt.type !== 'venue' || !receipt.entityId || !complete;
    add.href = '/submit/?venueEntityId='+encodeURIComponent(receipt.entityId ?? '');
  }
  function savePending(receipt: Receipt) { pending = receipt; write(pendingKey,receipt); retry.hidden = false; showReceipt(receipt,false); }
  function updateVersion(version: number) { if (pending) savePending({ ...pending,version }); }
  function renderPhotos(slot: keyof typeof photos) {
    const list = lists[slot]; list.replaceChildren();
    const inputId = slot === 'entity' ? 'entity-images' : 'review-images';
    form!.querySelector<HTMLElement>(`[data-photo-count=${inputId}]`)!.textContent = photos[slot].length ? `已选 ${photos[slot].length} 张，已压缩并移除位置数据。` : '可留空，首张照片将作为封面。';
    photos[slot].forEach((photo,index) => {
      const card = document.createElement('div'); card.className = 'upload-preview';
      const image = document.createElement('img'); image.src = photo.url; image.alt = photo.alt;
      const label = document.createElement('label'); const caption = document.createElement('span'); caption.textContent = '照片说明 ';
      const required = document.createElement('b'); required.className = 'required-mark'; required.textContent = '*'; required.setAttribute('aria-hidden','true'); caption.append(required); label.append(caption);
      const input = document.createElement('input'); input.value = photo.alt; input.required = true; input.maxLength = LIMITS.imageAlt; input.dataset.label = `${slot === 'entity' ? '封面' : '评价'}照片 ${index+1} 的说明`;
      input.addEventListener('input', () => { photo.alt = input.value; image.alt = input.value; }); label.append(input);
      const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '移除照片'; remove.addEventListener('click', () => { if (busy) return; URL.revokeObjectURL(photo.url); photos[slot].splice(index,1); renderPhotos(slot); syncFields(); });
      card.append(image,label,remove);
      if (slot === 'entity') { const cover = document.createElement(index === 0 ? 'span' : 'button'); cover.textContent = index === 0 ? '首张 · 食单封面' : '设为封面'; cover.className = 'cover-label'; if (cover instanceof HTMLButtonElement) { cover.type = 'button'; cover.addEventListener('click', () => { if(busy)return; photos.entity.splice(index,1); photos.entity.unshift(photo); renderPhotos('entity'); }); } card.append(cover); }
      list.append(card);
    });
  }
  for (const [slot,id,max] of [['entity','entity-images',LIMITS.entityImages],['attachedReview','review-images',LIMITS.reviewImages]] as const) {
    const input = form.querySelector<HTMLInputElement>('#'+id)!;
    input.addEventListener('change', async () => {
      if (busy) return;
      const files = [...(input.files ?? [])]; input.value = '';
      if (files.length + photos[slot].length > max) { message(`最多选择 ${max} 张${slot === 'entity' ? '店铺 / 餐品' : '评价'}照片，请先移除不需要的照片。`,'error'); return; }
      setBusy(true);
      try { const blobs = await Promise.all(files.map(compressReviewImage)); blobs.forEach(blob => photos[slot].push({ blob,url: URL.createObjectURL(blob),alt: (value(currentType()+'Name') || (currentType() === 'venue' ? '店铺' : '餐品'))+'的'+(slot === 'entity' ? '照片' : '用餐照片') })); renderPhotos(slot); message('照片已准备好，请确认来源与使用权。'); }
      catch (error) { message(error instanceof Error ? error.message : '无法读取照片，请换一张试试。','error'); }
      finally { setBusy(false); }
    });
  }
  const attached = () => { const rating = Number(form!.querySelector<HTMLInputElement>('input[name=attachedRating]:checked')?.value ?? 0); const text = value('attachedText'); return rating || text || photos.attachedReview.length ? { rating,text } : null; };
  function payload() {
    const type = currentType();
    const price = value(type+'Price') ? { amountCents: parseYuan(value(type+'Price')),currency: 'CNY',unit: type === 'venue' ? '人' : '份',source: value(type+'PriceSource') } : null;
    const data = type === 'venue' ? { name: value('venueName'),type: value('venueType'),campusScope: value('venueCategory'),location: { address: value('venueAddress'),campusArea: value('venueCampusArea') || null,floor: value('venueFloor') || null,distanceMeters: value('venueCategory') === 'off-campus' && value('venueDistanceMeters') ? Number(value('venueDistanceMeters')) : null,distanceBasis: value('venueCategory') === 'off-campus' ? value('venueDistanceBasis') || null : null },tags: splitTags(value('venueTags')),description: value('venueDescription') || null,averagePrice: price } : { name: value('foodName'),venueId: value('foodVenueId'),mealType: value('foodMealType') || null,tags: splitTags(value('foodTags')),description: value('foodDescription') || null,price };
    return { ...data,...(attached() ? { attachedReview: attached() } : {}) };
  }
  function parent() {
    if (currentType() !== 'food') return undefined;
    const id = value('foodVenueId'); const token = read('shou-parent-receipt:'+id);
    // This key intentionally stores a raw private token, matching the previous form.
    return { venueEntityId: id,...(token ? { parentReceiptToken: token } : {}) };
  }
  function photoMetadata() {
    const own = value('photoOrigin') === 'own';
    return { source: own ? '本人拍摄' : value('imageSource'),holder: own ? '匿名投稿者' : value('imageHolder'),license: own ? '本人授权本站展示及选作对应内容封面' : value('imageLicense'),rights: checked('rightsConfirmed'),coverAllowed: own && checked('rightsConfirmed'),illustrative: !own && checked('imageIllustrative') };
  }
  function validate() {
    syncFields(); clearFormErrors(form!);
    const problems = formProblems(form!);
    const add = (name: string, message: string) => problems.push({ element: field(name),message });
    const type = currentType();
    if(type==='food'&&!photos.entity.length)problems.push({element:form!.querySelector('#entity-images'),message:'餐品照片：请至少上传一张这道餐品的实拍图。'});
    if(type==='food'&&checked('imageIllustrative')&&value('photoOrigin')==='licensed')problems.push({element:field('imageIllustrative'),message:'新餐品需要实拍照片，请勿使用网络示意图。'});
    if (value(type+'Price') && parseYuan(value(type+'Price')) === null) add(type+'Price','价格：请输入 0–100000 元，最多两位小数。');
    const tags = splitTags(value(type+'Tags'));
    if (tags.length > LIMITS.tags || tags.some(tag => tag.length > LIMITS.tag) || new Set(tags.map(tag => tag.toLocaleLowerCase())).size !== tags.length) add(type+'Tags','标签：最多 30 个，每个最多 60 字，请去掉重复标签。');
    if (type === 'venue' && value('venueCategory') === 'off-campus' && Boolean(value('venueDistanceMeters')) !== Boolean(value('venueDistanceBasis'))) add(value('venueDistanceMeters') ? 'venueDistanceBasis' : 'venueDistanceMeters','距离与依据：请同时填写，或同时留空。');
    if (attached()?.rating === 0) problems.push({ element: form!.querySelector('input[name=attachedRating]'),message: '随稿评价：请先选择 1–5 星评分，也可以清空评价后只提交资料。' });
    if (Array.from(field('attachedText').value).length > LIMITS.reviewText) add('attachedText','随稿评价：最多 256 字。');
    const metadata = photoMetadata();
    if (!problems.length) {
      try {
        validateV2Submission({ schemaVersion: 2,entityType: type,snapshotId: form!.dataset.snapshotId,payload: payload(),parent: parent(),expectedImages: photos.entity.length,expectedReviewImages: photos.attachedReview.length,turnstileToken: 'browser-validation' });
        if (photos.entity.length + photos.attachedReview.length && (!metadata.source || !metadata.holder || !metadata.license)) throw new Error('请补全照片来源与授权。');
        if (photos.entity.length + photos.attachedReview.length && /^https?:\/\//i.test(metadata.source)) { const url = new URL(metadata.source); if (url.protocol !== 'https:' || url.username || url.password) add('imageSource','图片来源：请使用不含账号密码的 HTTPS 地址。'); }
        if (/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(metadata.source+metadata.holder+metadata.license)) add('imageSource','图片来源与授权信息包含无效控制字符。');
      } catch (error) {
        const code = error instanceof V2ValidationError ? error.code : '';
        const name = code.includes('description') ? type+'Description' : code.includes('name') ? type+'Name' : code.includes('address') ? 'venueAddress' : code.includes('price') ? type+'PriceSource' : code.includes('meal') ? 'foodMealType' : code.includes('review') ? 'attachedText' : type+'Name';
        add(name,'请检查填写内容与字段格式。'+(code ? `（${code}）` : ''));
      }
    }
    if (problems.length) { showFormErrors(form!,problems); feedback.textContent = '请先补全上方提示的内容。'; return false; }
    return true;
  }
  async function request(url: string, init: RequestInit = {}) {
    const response = await fetch(url,{ ...init,cache:'no-store' });
    const body = await response.json().catch(() => null);
    if (!response.ok) throw new SubmissionError(body?.error?.message || '服务暂时无法处理，请稍后重试。',body?.error?.code || 'request_failed',response.status);
    if (!body || typeof body !== 'object') throw new Error('服务器回执无效，请保持本次资料重试。');
    return body;
  }
  async function complete(receipt: Receipt) {
    const base = '/api/v2/submissions/'+encodeURIComponent(receipt.submissionId);
    const authorization = { Authorization:'Bearer '+receipt.receiptToken };
    const status = await request(base+'/status',{ headers:authorization });
    if (!Number.isSafeInteger(status.version)) throw new Error('回执版本无效。');
    updateVersion(status.version);
    if (status.uploadState === 'pending') return status.version as number;
    if (status.uploadState !== 'uploading') throw new Error('这份投稿当前无法继续上传，请在进度页查看状态。');
    let version: number = status.version;
    const metadata = photoMetadata();
    const limits = { entity:receipt.expectedImages,attachedReview:receipt.expectedReviewImages };
    for (const slot of ['entity','attachedReview'] as const) {
      const uploaded = slot === 'entity' ? status.uploadedImages : status.uploadedReviewImages;
      if (!Number.isInteger(uploaded) || uploaded < 0 || uploaded > limits[slot]) throw new Error('图片保存状态无效。');
      if (uploaded < limits[slot] && photos[slot].length !== limits[slot]) throw new Error(`请按原顺序重新选择 ${limits[slot]} 张${slot === 'entity' ? '店铺 / 餐品' : '评价'}照片；已经上传的部分会自动跳过。`);
      if (uploaded < limits[slot] && (!metadata.rights || photos[slot].some(photo => !photo.alt.trim()))) throw new Error('请补全照片说明并确认使用权。');
      for (let index = uploaded; index < limits[slot]; index++) {
        const photo = photos[slot][index];
        const body = await request(base+'/images',{ method:'POST',headers: { ...authorization,'Content-Type':'image/webp','X-Image-Slot':slot,'X-Image-Index':String(index),'X-Submission-Version':String(version),'X-Image-Metadata-Encoding':'percent-utf8','X-Image-Alt':encodeURIComponent(photo.alt.trim()),'X-Image-Source':encodeURIComponent(metadata.source),'X-Image-Copyright-Holder':encodeURIComponent(metadata.holder),'X-Image-License':encodeURIComponent(metadata.license),'X-Image-Rights-Confirmed':String(metadata.rights),'X-Image-Is-Illustrative':String(metadata.illustrative),'X-Image-Cover-Allowed':String(metadata.coverAllowed) },body:photo.blob });
        if (!Number.isSafeInteger(body.version)) throw new Error('图片回执版本无效。');
        version = body.version; updateVersion(version);
      }
    }
    const final = await request(base+'/finalize',{ method:'POST',headers: { ...authorization,'Content-Type':'application/json' },body:JSON.stringify({ expectedVersion:version,expectedImages:receipt.expectedImages,expectedReviewImages:receipt.expectedReviewImages }) });
    if (!Number.isSafeInteger(final.version)) throw new Error('完成回执版本无效。');
    return final.version as number;
  }
  function finished(receipt: Receipt, version: number) {
    const completeReceipt = { ...receipt,version }; showReceipt(completeReceipt);
    if (receipt.type === 'venue' && receipt.entityId) { try { sessionStorage.setItem('shou-parent-receipt:'+receipt.entityId,receipt.receiptToken); } catch { /* The receipt is still visible for manual preservation. */ } }
    pending = null; attempt = null; retry.hidden = true;
    try { sessionStorage.removeItem(pendingKey); } catch { /* Leave the visible receipt. */ }
    for (const slot of ['entity','attachedReview'] as const) { photos[slot].forEach(photo => URL.revokeObjectURL(photo.url)); photos[slot] = []; renderPhotos(slot); }
    form!.reset(); form!.querySelector<HTMLDetailsElement>('#attached-review')!.open = false; updateCount(); clearFormErrors(form!); resetTurnstile();
    message('投稿已收到，等待管理员审核。请保存下方回执。','success');
  }
  const widget = turnstileWidget();
  if (widget) form.querySelector('#turnstile-slot')!.append(widget);
  else message('当前投稿服务暂不可用，请稍后再试；你仍可填写并下载本地草稿。');
  const updateCount = () => { const count = Array.from(field('attachedText').value).length; form.querySelector<HTMLElement>('#attached-count')!.textContent = `${count} / 256`; field('attachedText').setCustomValidity(count > 256 ? '评价最多 256 字。' : ''); };
  form.querySelector('#remove-attached-review')!.addEventListener('click', () => { if(busy)return; form.querySelectorAll<HTMLInputElement>('input[name=attachedRating]').forEach(radio => { radio.checked = false; radio.dispatchEvent(new Event('change')); }); field('attachedText').value=''; photos.attachedReview.forEach(photo => URL.revokeObjectURL(photo.url)); photos.attachedReview=[]; renderPhotos('attachedReview'); updateCount(); syncFields(); });
  field('photoOrigin').addEventListener('change', () => { (field('rightsConfirmed') as HTMLInputElement).checked=false; form.querySelector('[data-rights-label]')!.textContent=value('photoOrigin') === 'own' ? '这些照片由本人拍摄，我授权本站展示，并可选作对应餐品或店铺的封面。' : '我确认已获得相应使用权，并授权本站按所填许可展示。'; syncFields(); });
  form.addEventListener('input', () => { if(!busy){updateCount();syncFields();} });
  form.addEventListener('change', () => { if(!busy){clearFormErrors(form);syncFields();} });
  form.addEventListener('submit', async event => {
    event.preventDefault(); if(busy)return;
    if(pending){message('请先继续保存上一份投稿，避免重复提交。','error');return;}
    if(!validate())return;
    const token = form.querySelector<HTMLInputElement>('[name=cf-turnstile-response]')?.value;
    if(!token){showFormErrors(form,[{element:form.querySelector('#turnstile-slot'),message:'请先完成真人验证。'}]);return;}
    const data = { schemaVersion:2,entityType:currentType(),snapshotId:form.dataset.snapshotId,payload:payload(),parent:parent(),expectedImages:photos.entity.length,expectedReviewImages:photos.attachedReview.length };
    const fingerprint=JSON.stringify(data);
    if(attempt && attempt.fingerprint !== fingerprint){message('上次提交结果尚未确认。请保持原资料和照片数量重试，避免重复投稿。','error');return;}
    attempt ??= { key:crypto.randomUUID(),fingerprint };
    setBusy(true); message('正在提交资料与照片，请稍候……');
    try {
      const result=await request('/api/v2/submissions',{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':attempt.key},body:JSON.stringify({...data,turnstileToken:token})});
      if(typeof result.submissionId !== 'string' || typeof result.receiptToken !== 'string' || !result.submissionId || !result.receiptToken || !Number.isSafeInteger(result.version))throw new Error('投稿回执无效，请保持原资料重试。');
      const receipt: Receipt = { submissionId:result.submissionId,receiptToken:result.receiptToken,version:result.version,type:currentType(),expectedImages:photos.entity.length,expectedReviewImages:photos.attachedReview.length,...(typeof result.entityId==='string'?{entityId:result.entityId}:{}) };
      savePending(receipt); finished(receipt,await complete(receipt));
    } catch(error) {
      if(error instanceof SubmissionError && error.status < 500 && !['idempotency_replayed','idempotency_conflict'].includes(error.code))attempt=null;
      message((error instanceof Error?error.message:'提交失败。')+(pending?' 资料与回执已保留，请使用“继续保存上一份投稿”。':''),'error'); resetTurnstile();
    } finally { setBusy(false); }
  });
  retry.addEventListener('click', async () => {
    if(busy || !pending)return;
    syncFields();
    const problems=formProblems(form!).filter(problem=>problem.element?.closest('#image-metadata, #entity-previews, #review-previews'));
    if(problems.length) { showFormErrors(form!,problems); return; }
    const receipt=pending;
    setBusy(true);
    try { finished(receipt,await complete(receipt)); }
    catch(error) { message((error instanceof Error?error.message:'重试失败。')+' 回执仍已保留。','error'); }
    finally { setBusy(false); }
  });
  document.querySelector('#receipt-token-toggle')!.addEventListener('click',event => { const input=document.querySelector<HTMLInputElement>('#receipt-token')!; const reveal=input.type==='password'; input.type=reveal?'text':'password'; (event.currentTarget as HTMLButtonElement).textContent=reveal?'隐藏':'显示'; (event.currentTarget as HTMLElement).setAttribute('aria-pressed',String(reveal)); });
  form.querySelector('#draft')!.addEventListener('click', () => { const blob=new Blob([JSON.stringify({schemaVersion:2,entityType:currentType(),payload:payload(),expectedImages:photos.entity.length,expectedReviewImages:photos.attachedReview.length},null,2)],{type:'application/json'}); const link=document.createElement('a'); const url=URL.createObjectURL(blob); link.href=url; link.download='shou-food-submission-v2.json'; document.body.append(link); link.click(); link.remove(); setTimeout(()=>URL.revokeObjectURL(url),2000); });
  const query=new URLSearchParams(location.search); const parentId=query.get('venueEntityId');
  if(query.get('venue'))location.replace('/restaurants/'+encodeURIComponent(query.get('venue')!)+'/#review-form');
  if(query.get('food'))location.replace('/foods/'+encodeURIComponent(query.get('food')!)+'/#review-form');
  if(parentId && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(parentId)) { const select=field('foodVenueId') as HTMLSelectElement; if(![...select.options].some(option=>option.value===parentId))select.add(new Option('刚投稿的店铺（审核中）',parentId)); select.value=parentId; form.querySelector<HTMLInputElement>('input[name=entityType][value=food]')!.checked=true; }
  try {
    const stored=JSON.parse(read(pendingKey)??'null');
    if(stored && typeof stored.submissionId==='string' && typeof stored.receiptToken==='string' && stored.receiptToken && ['venue','food'].includes(stored.type) && Number.isSafeInteger(stored.version) && Number.isInteger(stored.expectedImages) && stored.expectedImages>=0 && stored.expectedImages<=LIMITS.entityImages && Number.isInteger(stored.expectedReviewImages) && stored.expectedReviewImages>=0 && stored.expectedReviewImages<=LIMITS.reviewImages) {
      form.querySelector<HTMLInputElement>(`input[name=entityType][value=${stored.type}]`)!.checked=true;
      if(stored.expectedReviewImages) form.querySelector<HTMLDetailsElement>('#attached-review')!.open=true;
      savePending(stored);
      message('有一份投稿尚未完成。资料已经保存，可继续上传原来的照片。');
    }
  } catch { /* Ignore malformed private state. */ }
  syncFields();
}
