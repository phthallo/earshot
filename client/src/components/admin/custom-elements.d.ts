import 'react';

// esp-web-tools registers this element from a script tag; React only needs its attributes.
declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      'esp-web-install-button': React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & { manifest: string };
    }
  }
}
