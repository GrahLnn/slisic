export const I = <T>(x: T): T => x;
export const K =
  <T, U>(x: T) =>
  (_?: U): T =>
    x;
export const S =
  <A, B, C>(x: (a: A) => (b: B) => C) =>
  (y: (a: A) => B) =>
  (z: A): C =>
    x(z)(y(z));
export const B =
  <A, B, C>(f: (b: B) => C) =>
  (g: (a: A) => B) =>
  (x: A): C =>
    f(g(x));

export const C =
  <A, B, C>(f: (a: A) => (b: B) => C) =>
  (b: B) =>
  (a: A): C =>
    f(a)(b);

export const W =
  <A, B>(f: (a: A) => (b: A) => B) =>
  (x: A): B =>
    f(x)(x);
export const T =
  <A, B>(x: A) =>
  (f: (a: A) => B): B =>
    f(x);
