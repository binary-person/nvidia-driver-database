export interface LinuxCudaThreshold {
	label: string;
	minDisplayVersion: string;
}

export const LINUX_X86_64_OS_NAME = 'Linux 64-bit';

// Source: NVIDIA CUDA Toolkit release notes compatibility table.
// https://docs.nvidia.com/cuda/cuda-toolkit-release-notes/#id7
export const LINUX_X86_64_CUDA_THRESHOLDS: LinuxCudaThreshold[] = [
	{ label: 'CUDA 13.2 Update 1', minDisplayVersion: '595.58.03' },
	{ label: 'CUDA 13.2 GA', minDisplayVersion: '595.45.04' },
	{ label: 'CUDA 13.1 Update 1', minDisplayVersion: '590.48.01' },
	{ label: 'CUDA 13.1 GA', minDisplayVersion: '590.44.01' },
	{ label: 'CUDA 13.0 Update 2', minDisplayVersion: '580.95.05' },
	{ label: 'CUDA 13.0 Update 1', minDisplayVersion: '580.82.07' },
	{ label: 'CUDA 13.0 GA', minDisplayVersion: '580.65.06' },
	{ label: 'CUDA 12.9 Update 1', minDisplayVersion: '575.57.08' },
	{ label: 'CUDA 12.9 GA', minDisplayVersion: '575.51.03' },
	{ label: 'CUDA 12.8 Update 1', minDisplayVersion: '570.124.06' },
	{ label: 'CUDA 12.8 GA', minDisplayVersion: '570.26' },
	{ label: 'CUDA 12.6 Update 3', minDisplayVersion: '560.35.05' },
	{ label: 'CUDA 12.6 Update 2', minDisplayVersion: '560.35.03' },
	{ label: 'CUDA 12.6 Update 1', minDisplayVersion: '560.35.03' },
	{ label: 'CUDA 12.6 GA', minDisplayVersion: '560.28.03' },
	{ label: 'CUDA 12.5 Update 1', minDisplayVersion: '555.42.06' },
	{ label: 'CUDA 12.5 GA', minDisplayVersion: '555.42.02' },
	{ label: 'CUDA 12.4 Update 1', minDisplayVersion: '550.54.15' },
	{ label: 'CUDA 12.4 GA', minDisplayVersion: '550.54.14' },
	{ label: 'CUDA 12.3 Update 1', minDisplayVersion: '545.23.08' },
	{ label: 'CUDA 12.3 GA', minDisplayVersion: '545.23.06' },
	{ label: 'CUDA 12.2 Update 2', minDisplayVersion: '535.104.05' },
	{ label: 'CUDA 12.2 Update 1', minDisplayVersion: '535.86.09' },
	{ label: 'CUDA 12.2 GA', minDisplayVersion: '535.54.03' },
	{ label: 'CUDA 12.1 Update 1', minDisplayVersion: '530.30.02' },
	{ label: 'CUDA 12.1 GA', minDisplayVersion: '530.30.02' },
	{ label: 'CUDA 12.0 Update 1', minDisplayVersion: '525.85.12' },
	{ label: 'CUDA 12.0 GA', minDisplayVersion: '525.60.13' },
	{ label: 'CUDA 11.8 GA', minDisplayVersion: '520.61.05' },
	{ label: 'CUDA 11.7 Update 1', minDisplayVersion: '515.48.07' },
	{ label: 'CUDA 11.7 GA', minDisplayVersion: '515.43.04' },
	{ label: 'CUDA 11.6 Update 2', minDisplayVersion: '510.47.03' },
	{ label: 'CUDA 11.6 Update 1', minDisplayVersion: '510.47.03' },
	{ label: 'CUDA 11.6 GA', minDisplayVersion: '510.39.01' },
	{ label: 'CUDA 11.5 Update 2', minDisplayVersion: '495.29.05' },
	{ label: 'CUDA 11.5 Update 1', minDisplayVersion: '495.29.05' },
	{ label: 'CUDA 11.5 GA', minDisplayVersion: '495.29.05' },
	{ label: 'CUDA 11.4 Update 4', minDisplayVersion: '470.82.01' },
	{ label: 'CUDA 11.4 Update 3', minDisplayVersion: '470.82.01' },
	{ label: 'CUDA 11.4 Update 2', minDisplayVersion: '470.57.02' },
	{ label: 'CUDA 11.4 Update 1', minDisplayVersion: '470.57.02' },
	{ label: 'CUDA 11.4.0 GA', minDisplayVersion: '470.42.01' },
	{ label: 'CUDA 11.3.1 Update 1', minDisplayVersion: '465.19.01' },
	{ label: 'CUDA 11.3.0 GA', minDisplayVersion: '465.19.01' },
	{ label: 'CUDA 11.2.2 Update 2', minDisplayVersion: '460.32.03' },
	{ label: 'CUDA 11.2.1 Update 1', minDisplayVersion: '460.32.03' },
	{ label: 'CUDA 11.2.0 GA', minDisplayVersion: '460.27.03' },
	{ label: 'CUDA 11.1.1 Update 1', minDisplayVersion: '455.32' },
	{ label: 'CUDA 11.1 GA', minDisplayVersion: '455.23' },
	{ label: 'CUDA 11.0.3 Update 1', minDisplayVersion: '450.51.06' },
	{ label: 'CUDA 11.0.2 GA', minDisplayVersion: '450.51.05' },
	{ label: 'CUDA 11.0.1 RC', minDisplayVersion: '450.36.06' },
	{ label: 'CUDA 10.2.89', minDisplayVersion: '440.33' },
	{ label: 'CUDA 10.1 (10.1.105 general release, and updates)', minDisplayVersion: '418.39' },
	{ label: 'CUDA 10.0.130', minDisplayVersion: '410.48' },
	{ label: 'CUDA 9.2 (9.2.148 Update 1)', minDisplayVersion: '396.37' },
	{ label: 'CUDA 9.2 (9.2.88)', minDisplayVersion: '396.26' },
	{ label: 'CUDA 9.1 (9.1.85)', minDisplayVersion: '390.46' },
	{ label: 'CUDA 9.0 (9.0.76)', minDisplayVersion: '384.81' },
	{ label: 'CUDA 8.0 (8.0.61 GA2)', minDisplayVersion: '375.26' },
	{ label: 'CUDA 8.0 (8.0.44)', minDisplayVersion: '367.48' },
	{ label: 'CUDA 7.5 (7.5.16)', minDisplayVersion: '352.31' },
	{ label: 'CUDA 7.0 (7.0.28)', minDisplayVersion: '346.46' }
];

function parseDisplayVersion(displayVersion: string): number[] | null {
	const trimmedDisplayVersion = displayVersion.trim();
	if (!trimmedDisplayVersion || !/^\d+(?:\.\d+)*$/.test(trimmedDisplayVersion)) {
		return null;
	}

	return trimmedDisplayVersion.split('.').map((segment) => Number(segment));
}

export function compareNvidiaDottedVersions(
	leftDisplayVersion: string,
	rightDisplayVersion: string
): number | null {
	const leftSegments = parseDisplayVersion(leftDisplayVersion);
	const rightSegments = parseDisplayVersion(rightDisplayVersion);

	if (!leftSegments || !rightSegments) {
		return null;
	}

	const segmentCount = Math.max(leftSegments.length, rightSegments.length);
	for (let index = 0; index < segmentCount; index += 1) {
		const leftValue = leftSegments[index] ?? 0;
		const rightValue = rightSegments[index] ?? 0;
		if (leftValue !== rightValue) {
			return leftValue > rightValue ? 1 : -1;
		}
	}

	return 0;
}

export function compareLinuxCudaDisplayVersions(
	leftDisplayVersion: string,
	rightDisplayVersion: string
): number | null {
	return compareNvidiaDottedVersions(leftDisplayVersion, rightDisplayVersion);
}

export function getLinuxCudaCompatibilityLabel(displayVersion: string): string | null {
	for (const threshold of LINUX_X86_64_CUDA_THRESHOLDS) {
		const comparison = compareNvidiaDottedVersions(
			displayVersion,
			threshold.minDisplayVersion
		);
		if (comparison !== null && comparison >= 0) {
			return threshold.label;
		}
	}

	return null;
}

export function getLinuxCudaDisplayTooltip(
	osName: string,
	displayVersion: string
): string | null {
	if (osName !== LINUX_X86_64_OS_NAME) {
		return null;
	}

	const trimmedDisplayVersion = displayVersion.trim();
	if (!trimmedDisplayVersion) {
		return null;
	}

	const label = getLinuxCudaCompatibilityLabel(trimmedDisplayVersion);
	return label ? `${trimmedDisplayVersion} (${label})` : null;
}
