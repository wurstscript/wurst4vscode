'use strict';

import * as path from 'path';
import * as os from 'os';

export const WURST_HOME = path.join(os.homedir(), '.wurst');
export const RUNTIME_DIR = path.join(WURST_HOME, 'wurst-runtime');
export const COMPILER_DIR = path.join(WURST_HOME, 'wurst-compiler');
export const COMPILER_JAR = path.join(COMPILER_DIR, 'wurstscript.jar');
export const LEGACY_GRILL_DIR = path.join(WURST_HOME, 'grill');
export const GRILL_HOME_DIR = path.join(WURST_HOME, 'grill-cli');

export const NIGHTLY_RELEASE_BY_TAG_API = 'https://api.github.com/repos/wurstscript/WurstScript/releases/tags/nightly';
export const NIGHTLY_COMMIT_API = 'https://api.github.com/repos/wurstscript/WurstScript/commits/nightly';
export const WURSTSETUP_RELEASE = 'https://api.github.com/repos/wurstscript/WurstSetup/releases/tags/nightly-master';
