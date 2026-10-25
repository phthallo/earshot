import { useEffect } from 'react';
import { api } from '../../api';
import { copy } from '../../copy';

// The marketing page's sign-in buttons link to /venues?signin=1; a signed-out visitor goes straight to GitHub.
export const SIGNIN_PARAM = 'signin';

// Inside a card that has its own title, `title` is null and the sheet starts at the intro.
export function SignIn({ title = copy.admin.signInTitle }: { title?: string | null }) {
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (!params.has(SIGNIN_PARAM)) return;
    params.delete(SIGNIN_PARAM);
    const qs = params.toString();
    history.replaceState(null, '', qs ? `${location.pathname}?${qs}` : location.pathname);
    location.assign(api.githubSignInUrl());
  }, []);

  return (
    <section className="sheet">
      {title && <h2>{title}</h2>}
      <p className="intro">{copy.admin.signInIntro}</p>
      <a className="button primary" href={api.githubSignInUrl()}>
        {copy.admin.signInGithub}
      </a>
    </section>
  );
}
