import { WebRuntimeAdapter } from './web.js';
import { BackendRuntimeAdapter } from './backend.js';
import { CliRuntimeAdapter } from './cli.js';
import { AndroidRuntimeAdapter } from './android.js';
import { IOSRuntimeAdapter } from './ios.js';
import { DesktopRuntimeAdapter } from './desktop.js';
import { GenericRuntimeAdapter } from './generic.js';

export function createRuntimeAdapters() {
  return [
    new WebRuntimeAdapter(),
    new AndroidRuntimeAdapter(),
    new IOSRuntimeAdapter(),
    new BackendRuntimeAdapter(),
    new CliRuntimeAdapter(),
    new DesktopRuntimeAdapter(),
    new GenericRuntimeAdapter()
  ];
}

export function adapterFor(plan, adapters = createRuntimeAdapters()) {
  return adapters.find(item => item.canHandle(plan)) || adapters.at(-1);
}
