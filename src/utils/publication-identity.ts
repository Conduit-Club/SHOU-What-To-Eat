import type { AccountSession } from './auth-session';
import { publicAvatar } from './review-identity';

/** Both contribution forms present the same explicit privacy choice. */
export function updatePublicationIdentity(root: HTMLElement, user: AccountSession['user']) {
  const choice = root.querySelector<HTMLInputElement>('[data-username-choice]')!;
  const label = root.querySelector<HTMLElement>('[data-username-label]')!;
  const image = root.querySelector<HTMLImageElement>('[data-identity-avatar]')!;
  const initial = root.querySelector<HTMLElement>('[data-identity-initial]')!;
  choice.disabled = !user;
  choice.dataset.accountAvailable = String(Boolean(user));
  label.textContent = user ? `公开用户名「${user.username}」与头像` : '公开账号用户名与头像（登录后可选）';
  initial.textContent = user ? Array.from(user.username)[0] : '我';
  const picture = user ? publicAvatar(user.picture) : null;
  image.hidden = !picture;
  if (picture) image.src = picture; else image.removeAttribute('src');
  const update = () => {
    root.querySelector<HTMLElement>('[data-identity-note]')!.textContent = choice.checked
      ? user ? `这条评价将公开「${user.username}」及头像；头像失效时显示名字首字。` : '请先登录，才能以账号用户名和头像发表；也可重新选择匿名。'
      : '这条评价仅显示「匿名同学」，不公开账号用户名或头像。';
  };
  update();
  return update;
}
