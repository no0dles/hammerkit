import {RunArg} from '../src/run-arg';
import consola from 'consola';

export function getTestArg(): [RunArg, jest.Mock] {
  const mock = jest.fn();
  consola.mock(() => mock);
  return [new RunArg(false, 0), mock];
}
