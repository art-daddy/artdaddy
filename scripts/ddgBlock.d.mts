export interface DdgPageState {
  results: number;
  bodyLen: number;
  title: string;
  challenge: boolean;
}

export function ddgBlocked(state: DdgPageState): boolean;
