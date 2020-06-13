'use strict';

const ffmpegPath = require('ffmpeg-static');
const { path: ffprobePath } = require('ffprobe-static');
const { execFile } = require('child_process');
const fse = require('fs-extra');
const fs = require('fs');
const path = require('path');

const minimumNotSilentDuration = 1;
const remainingSilentDuration = 0.4;
const minimumSilentDuration = 0.2;

async function main(mode, ...args) {
    if (mode === 'file') {
        await removeSilentFromVideoFile(...args);
    }
    else if (mode === 'dir') {
        await removeSilentFromVideoDirectory(...args);
    }
    else {
        console.error('Unknown mode, fallback file mode: ', mode);
        await main('file', ...arguments);
    }
}

async function removeSilentFromVideoDirectory(videoDirPath, outputDirPath) {
    const videoDirBasename = path.basename(videoDirPath);
    const videoDirDirname = path.dirname(videoDirPath);
    if (!outputDirPath) {
        outputDirPath = path.join(videoDirDirname, videoDirBasename + '.silenceremoved');
    }
    const videoFilenameList = await fs.promises.readdir(videoDirPath);

    await fse.mkdirp(outputDirPath);
    for (const filename of videoFilenameList) {
        const videoFilePath = path.join(videoDirPath, filename);
        const outputFilePath = path.join(outputDirPath, filename);
        if (await isVideoFile(outputFilePath)) {
            // already done
            continue;
        }
        if (await isVideoFile(videoFilePath)) {
            try {
                await removeSilentFromVideoFile(videoFilePath, outputFilePath);
            }
            catch (err) {
                if (err.message.match(/Too many packets buffered for output stream/)) {
                    console.error('Ignore error that cannot be resolved: ', err);
                }
                else {
                    throw err
                }
            }
        }
    }
}

async function removeSilentFromVideoFile(videoPath, outputVideoPath) {
    const videoExtname = path.extname(videoPath);
    const videoBasename = path.basename(videoPath, videoExtname);
    const videoDirname = path.dirname(videoPath);
    if (!outputVideoPath) {
        outputVideoPath = path.join(videoDirname, videoBasename + '.silenceremoved' + videoExtname)
    }
    const outputVideoExtname = path.extname(outputVideoPath);
    const chunkedVideoDirname = outputVideoPath + '.tmp';

    const videoDurationStr = await execFfprobe('-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', videoPath);
    const videoDuration = parseFloat(videoDurationStr);

    const volumeDetectOutput = await execFfmpeg('-i', videoPath, '-af', 'volumedetect', '-f', 'null', '-');
    const meanVolume = getMinValumeFromVolumeDetectOutput(volumeDetectOutput);

    const thresholdVolume = meanVolume - 0;
    const thresholdDuration = minimumSilentDuration + remainingSilentDuration;

    const silenceDetectOutput = await execFfmpeg('-i', videoPath, '-af', `silencedetect=n=${thresholdVolume}dB:d=${thresholdDuration}`, '-f', 'null', '-');
    const silentPeriodList = getSilentPeriodListFromSilenceDetectOutput(silenceDetectOutput);

    let notSilentPeriodList = [];
    let lastEndPosition = 0;
    for (const [startPosition, endPosition] of silentPeriodList) {
        if (startPosition - lastEndPosition > minimumNotSilentDuration) {
            notSilentPeriodList.push([lastEndPosition, startPosition]);
        }
        lastEndPosition = endPosition;
    }
    if (videoDuration - lastEndPosition > minimumNotSilentDuration) {
        notSilentPeriodList.push([lastEndPosition, videoDuration]);
    }

    notSilentPeriodList = adjustNotSilentPeriodList(notSilentPeriodList);

    if (notSilentPeriodList.length > 0) {
        await fse.mkdirp(chunkedVideoDirname);

        const chunkedVideoFilePathList = [];
        for (const [startPosition, endPosition] of notSilentPeriodList) {
            const chunkedVideoFilePath = path.join(chunkedVideoDirname, startPosition + '-' + endPosition + outputVideoExtname);
            await execFfmpeg('-y', '-ss', startPosition, '-t', endPosition - startPosition, '-i', videoPath, chunkedVideoFilePath);
            chunkedVideoFilePathList.push(chunkedVideoFilePath);
        }

        const concatFilePath = path.join(chunkedVideoDirname, 'filelist.txt');
        const concatFileContent = chunkedVideoFilePathList.map(filePath => {
            // https://www.ffmpeg.org/ffmpeg-utils.html#toc-Examples
            return `file '${filePath.replace(/'/, "'\\''")}'`;
        }).join('\n');
        await fse.outputFile(concatFilePath, concatFileContent);

        await execFfmpeg('-y', '-f', 'concat', '-safe', '0', '-i', concatFilePath, '-c', 'copy', outputVideoPath);

        await fse.remove(chunkedVideoDirname);
    }
}

async function isVideoFile(path) {
    try {
        await execFfprobe('-i', path);
        return true;
    }
    catch (err) {
        return false;
    }
}

async function execFfmpeg(...args) {
    return new Promise((ok, ng) => {
        execFile(ffmpegPath, args, { maxBuffer: 100 * 1024 * 1024 }, (err, stdoutOutput, stderrOutput) => {
            if (err) {
                ng(err);
            }
            else {
                ok(stderrOutput);
            }
        });
    });
}

async function execFfprobe(...args) {
    return new Promise((ok, ng) => {
        execFile(ffprobePath, args, { maxBuffer: 100 * 1024 * 1024 }, (err, stdoutOutput, stderrOutput) => {
            if (err) {
                ng(err);
            }
            else {
                ok(stdoutOutput);
            }
        });
    });
}

function getMinValumeFromVolumeDetectOutput(output) {
    const matched = output.match(/^\[Parsed_volumedetect_\d[^\]]*\]\s*mean_volume\s*:\s*(-?\d+(?:\.\d+)?)\s*dB$/m);
    if (!matched) {
        throw Error('Volume Detect Output Error: ' + output);
    }
    return parseFloat(matched[1]);
}

function getSilentPeriodListFromSilenceDetectOutput(output) {
    const matched = output.matchAll(/^\[silencedetect[^\]]*\]\s*silence_(start|end)\s*:\s*(\d+(?:\.\d+)?)/mg);
    if (!matched) {
        return [];
    }
    let lastPosition = -1;
    let startPosition = null;
    const periodList = [];
    for (const matchedLine of matched) {
        const { 1: type, 2: positionStr } = matchedLine;
        const position = parseFloat(positionStr);
        if (startPosition === null) {
            if (type !== 'start') {
                throw Error('Unexpected period end: ' + output);
            }
            startPosition = position;
        }
        else {
            if (type !== 'end') {
                throw Error('Unexpected period start: ' + output);
            }
            periodList.push([startPosition, position]);
            startPosition = null;
        }
        lastPosition = position;
    }
    return periodList;
}

function adjustNotSilentPeriodList(periodList) {
    const adjustedList = [];

    // shorten
    for (let i = 0; i < periodList.length; i++) {
        const [startPosition, endPosition] = periodList[i];
        const extendedStartPosition = (i === 0) ? startPosition : (startPosition - (remainingSilentDuration / 2));
        const extendedEndPosition = (i === periodList.length - 1) ? endPosition : (endPosition + (remainingSilentDuration / 2));
        adjustedList.push([extendedStartPosition, extendedEndPosition]);
    }

    return adjustedList;
}

main(...process.argv.slice(2));

