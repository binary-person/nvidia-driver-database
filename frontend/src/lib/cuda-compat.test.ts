import { describe, expect, it } from 'vitest';

import {
	compareNvidiaDottedVersions,
	compareLinuxCudaDisplayVersions,
	getLinuxCudaCompatibilityLabel,
	getLinuxCudaDisplayTooltip
} from './cuda-compat';

describe('cuda-compat', () => {
	it('compares dotted NVIDIA display versions numerically', () => {
		expect(compareNvidiaDottedVersions('580.142', '580.65.06')).toBe(1);
		expect(compareLinuxCudaDisplayVersions('595.58.03', '595.45.04')).toBe(1);
		expect(compareLinuxCudaDisplayVersions('570.26', '570.124.06')).toBe(-1);
		expect(compareLinuxCudaDisplayVersions('455.32', '455.32.00')).toBe(0);
		expect(compareLinuxCudaDisplayVersions('not-a-version', '455.32')).toBeNull();
	});

	it('maps Linux x86_64 display versions to the newest matching CUDA label', () => {
		expect(getLinuxCudaCompatibilityLabel('595.58.03')).toBe('CUDA 13.2 Update 1');
		expect(getLinuxCudaCompatibilityLabel('595.45.04')).toBe('CUDA 13.2 GA');
		expect(getLinuxCudaCompatibilityLabel('570.124.06')).toBe('CUDA 12.8 Update 1');
		expect(getLinuxCudaCompatibilityLabel('570.26')).toBe('CUDA 12.8 GA');
		expect(getLinuxCudaCompatibilityLabel('346.46')).toBe('CUDA 7.0 (7.0.28)');
		expect(getLinuxCudaCompatibilityLabel('300.10')).toBeNull();
	});

	it('builds Linux-only display tooltips and falls back safely', () => {
		expect(getLinuxCudaDisplayTooltip('Linux 64-bit', '595.58.03')).toBe(
			'595.58.03 (CUDA 13.2 Update 1)'
		);
		expect(getLinuxCudaDisplayTooltip('Windows 11', '595.58.03')).toBeNull();
		expect(getLinuxCudaDisplayTooltip('Linux 32-bit', '595.58.03')).toBeNull();
		expect(getLinuxCudaDisplayTooltip('Linux 64-bit', '')).toBeNull();
		expect(getLinuxCudaDisplayTooltip('Linux 64-bit', 'preview')).toBeNull();
	});
});
