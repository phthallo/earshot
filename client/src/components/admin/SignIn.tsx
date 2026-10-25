import { api } from '../../api';
import { copy } from '../../copy';

export function SignIn() {
  return (
    <section className="sheet">
      <h2>{copy.admin.signInTitle}</h2>
      <p className="intro">{copy.admin.signInIntro}</p>
      <a className="button primary" href={api.githubSignInUrl()}>
        {copy.admin.signInGithub}
      </a>
    </section>
  );
}
