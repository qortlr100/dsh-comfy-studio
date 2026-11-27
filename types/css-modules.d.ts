// What a `*.module.css` import evaluates to in a browser bundle: the map from the class names
// written in the stylesheet to the renamed ones. scripts/build-client.ts produces it.
declare module "*.module.css" {
  const classes: Readonly<Record<string, string>>;
  export default classes;
}
