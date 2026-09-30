/**
 * Presentation titles for the ten scenes. Outcomes stay in the transcript;
 * these names only label the scene numbers the events already carry.
 */

export const SCENE_TITLES: readonly { readonly scene: number; readonly title: string }[] = [
  { scene: 1, title: 'Portfolio Mandate' },
  { scene: 2, title: 'Five agents search' },
  { scene: 3, title: 'Resource conflict' },
  { scene: 4, title: 'Mandate Room' },
  { scene: 5, title: 'Independent reverification' },
  { scene: 6, title: 'Malicious authorized agent' },
  { scene: 7, title: 'Fault isolation' },
  { scene: 8, title: 'Same agent, compliant action' },
  { scene: 9, title: 'Portfolio-level conflict' },
  { scene: 10, title: 'Receipt and evidence' },
];

export const SCENE_COUNT = SCENE_TITLES.length;

export function sceneTitle(scene: number): string {
  return SCENE_TITLES.find((item) => item.scene === scene)?.title ?? `Scene ${scene}`;
}
