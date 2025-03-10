/* Copyright(C) 2019-2022, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * protect-camera.ts: Camera device class for UniFi Protect.
 */
import {
  PROTECT_CONTACT_MOTION_SMARTDETECT,
  PROTECT_SWITCH_DOORBELL_TRIGGER,
  PROTECT_SWITCH_HKSV_RECORDING,
  PROTECT_SWITCH_MOTION_SENSOR,
  PROTECT_SWITCH_MOTION_TRIGGER,
  ProtectAccessory
} from "./protect-accessory";
import { ProtectApi, ProtectCameraChannelConfig, ProtectCameraConfig, ProtectNvrBootstrap } from "unifi-protect";
import { CharacteristicValue } from "homebridge";
import { PROTECT_HOMEKIT_IDR_INTERVAL } from "./settings";
import { ProtectNvr } from "./protect-nvr";
import { ProtectStreamingDelegate } from "./protect-stream";

export interface RtspEntry {

  channel: ProtectCameraChannelConfig,
  name: string,
  resolution: [ number, number, number],
  url: string
}

export class ProtectCamera extends ProtectAccessory {

  private isDoorbellConfigured!: boolean;
  public isHksv!: boolean;
  public isRinging!: boolean;
  private isVideoConfigured!: boolean;
  private rtspEntries!: RtspEntry[];
  private rtspQuality!: { [index: string]: string };
  public smartDetectTypes!: string[];
  public snapshotUrl!: string;
  public stream!: ProtectStreamingDelegate;
  public twoWayAudio!: boolean;

  // Configure a camera accessory for HomeKit.
  protected async configureDevice(): Promise<boolean> {

    this.isDoorbellConfigured = false;
    this.isHksv = false;
    this.isRinging = false;
    this.isVideoConfigured = false;
    this.rtspQuality = {};
    this.smartDetectTypes = [];

    // Save the device object before we wipeout the context.
    const device = this.accessory.context.device as ProtectCameraConfig;

    // Default to enabling camera motion detection.
    let detectMotion = true;

    // Save the motion sensor switch state before we wipeout the context.
    if(this.accessory.context.detectMotion !== undefined) {
      detectMotion = this.accessory.context.detectMotion as boolean;
    }

    // Default to enabling HKSV recording.
    let hksvRecording = true;

    // Save the HKSV recording switch state before we wipeout the context.
    if(this.accessory.context.hksvRecording !== undefined) {
      hksvRecording = this.accessory.context.hksvRecording as boolean;
    }

    // Clean out the context object in case it's been polluted somehow.
    this.accessory.context = {};
    this.accessory.context.device = device;
    this.accessory.context.nvr = this.nvr.nvrApi.bootstrap?.nvr.mac;
    this.accessory.context.detectMotion = detectMotion;
    this.accessory.context.hksvRecording = hksvRecording;

    // Inform the user if we have enabled dynamic bitrates.
    if(this.nvr?.optionEnabled(this.accessory.context.device as ProtectCameraConfig, "Video.Dynamic.Bitrates", false)) {

      this.log.info("%s: Dynamic adjustment of bitrates using the UniFi Protect controller enabled.", this.name());
    }

    // If the camera supports it, check to see if we have smart motion events enabled.
    if(device.featureFlags.hasSmartDetect && this.nvr?.optionEnabled(device, "Motion.SmartDetect", false)) {

      // We deal with smart motion detection options here and save them on the ProtectCamera instance because
      // we're trying to optimize and reduce the number of feature option lookups we do in realtime, when possible.
      // Reading a stream of constant events and having to perform a string comparison through a list of options multiple
      // times a second isn't an ideal use of CPU cycles, even if you have plenty of them to spare. Instead, we perform
      // that lookup once, here, and set the appropriate option booleans for faster lookup and use later in event
      // detection.

      // Check for the smart motion detection object types that UniFi Protect supports.
      this.smartDetectTypes = device.featureFlags.smartDetectTypes.filter(x => this.nvr?.optionEnabled(device, "Motion.SmartDetect." + x));

      // Inform the user of what smart detection object types we're configured for.
      this.log.info("%s: Smart motion detection enabled%s.", this.name(), this.smartDetectTypes.length ? ": " + this.smartDetectTypes.join(", ") : "");
    }

    // Configure accessory information.
    this.configureInfo();

    // Configure MQTT services.
    this.configureMqtt();

    // Configure the motion sensor.
    this.configureMotionSensor();
    this.configureMotionSwitch();
    this.configureMotionTrigger();

    // Configure smart motion contact sensors.
    this.configureMotionSmartSensor();

    // Configure two-way audio support.
    this.configureTwoWayAudio();

    // Configure HomeKit Secure Video suport.
    this.configureHksv();
    this.configureHksvRecordingSwitch();

    // Configure our video stream.
    await this.configureVideoStream();

    // Configure our camera details.
    this.configureCameraDetails();

    // Configure the doorbell trigger.
    this.configureDoorbellTrigger();

    return true;
  }

  // Configure discrete smart motion contact sensors for HomeKit.
  private configureMotionSmartSensor(): boolean {

    const device = this.accessory.context.device as ProtectCameraConfig;

    // Check for object-centric contact sensors that are no longer enabled and remove them.
    for(const objectService of this.accessory.services.filter(x => x.subtype?.startsWith(PROTECT_CONTACT_MOTION_SMARTDETECT + "."))) {

      // If we have motion sensors as well as object contact sensors enabled, and we have this object type enabled on this camera, we're good here.
      if(this.nvr?.optionEnabled(device, "Motion.Sensor") &&
        this.nvr?.optionEnabled(device, "Motion.SmartDetect.ObjectSensors", false)) {
        continue;
      }

      // We don't have this contact sensor enabled, remove it.
      this.accessory.removeService(objectService);
      this.log.info("%s: Disabling smart motion contact sensor: %s.", this.name(), objectService.subtype?.slice(objectService.subtype?.indexOf(".") + 1));
    }

    // Have we disabled motion sensors? If so, we're done.
    if(!this.nvr?.optionEnabled(device, "Motion.Sensor")) {
      return false;
    }

    // Have we enabled discrete contact sensors for specific object types? If not, we're done here.
    if(!this.nvr?.optionEnabled(device, "Motion.SmartDetect.ObjectSensors", false)) {
      return false;
    }

    // Add individual contact sensors for each object detection type, if needed.
    for(const smartDetectType of device.featureFlags.smartDetectTypes) {

      // See if we already have this contact sensor configured.
      let contactService = this.accessory.getServiceById(this.hap.Service.ContactSensor, PROTECT_CONTACT_MOTION_SMARTDETECT + "." + smartDetectType);

      // If not, let's add it.
      if(!contactService) {

        contactService = new this.hap.Service.ContactSensor(this.accessory.displayName + " " + smartDetectType.charAt(0).toUpperCase() + smartDetectType.slice(1),
          PROTECT_CONTACT_MOTION_SMARTDETECT + "." + smartDetectType);

        // Something went wrong, we're done here.
        if(!contactService) {
          this.log.error("%s: Unable to add smart motion contact sensor for %s detection.", this.name(), smartDetectType);
          return false;
        }

        // Finally, add it to the camera.
        this.accessory.addService(contactService);
      }

      // Initialize the sensor.
      contactService.updateCharacteristic(this.hap.Characteristic.ContactSensorState, false);
    }

    this.log.info("%s: Smart motion contact sensor%s enabled: %s.", this.name(),
      device.featureFlags.smartDetectTypes.length > 1 ? "s" : "", device.featureFlags.smartDetectTypes.join(", "));

    return true;
  }

  // Configure a switch to manually trigger a motion sensor event for HomeKit.
  private configureMotionTrigger(): boolean {

    // Find the switch service, if it exists.
    let triggerService = this.accessory.getServiceById(this.hap.Service.Switch, PROTECT_SWITCH_MOTION_TRIGGER);

    // Motion triggers are disabled by default and primarily exist for automation purposes.
    if(!this.nvr?.optionEnabled(this.accessory.context.device as ProtectCameraConfig, "Motion.Sensor") ||
      !this.nvr?.optionEnabled(this.accessory.context.device as ProtectCameraConfig, "Motion.Trigger", false)) {

      if(triggerService) {
        this.accessory.removeService(triggerService);
      }

      return false;
    }

    // Add the switch to the camera, if needed.
    if(!triggerService) {
      triggerService = new this.hap.Service.Switch(this.accessory.displayName + " Motion Trigger", PROTECT_SWITCH_MOTION_TRIGGER);

      if(!triggerService) {
        this.log.error("%s: Unable to add motion sensor trigger.", this.name());
        return false;
      }

      this.accessory.addService(triggerService);
    }

    const motionService = this.accessory.getService(this.hap.Service.MotionSensor);
    const switchService = this.accessory.getServiceById(this.hap.Service.Switch, PROTECT_SWITCH_MOTION_SENSOR);

    // Activate or deactivate motion detection.
    triggerService
      .getCharacteristic(this.hap.Characteristic.On)
      ?.onGet(() => {

        return motionService?.getCharacteristic(this.hap.Characteristic.MotionDetected).value === true;
      })
      .onSet((value: CharacteristicValue) => {

        if(value) {

          // Check to see if motion events are disabled.
          if(switchService && !switchService.getCharacteristic(this.hap.Characteristic.On).value) {
            setTimeout(() => {
              triggerService?.updateCharacteristic(this.hap.Characteristic.On, false);
            }, 50);

          } else {

            // Trigger the motion event.
            this.nvr.events.motionEventHandler(this.accessory, Date.now());
            this.log.info("%s: Motion event triggered.", this.name());
          }

        } else {

          // If the motion sensor is still on, we should be as well.
          if(motionService?.getCharacteristic(this.hap.Characteristic.MotionDetected).value) {
            setTimeout(() => {
              triggerService?.updateCharacteristic(this.hap.Characteristic.On, true);
            }, 50);
          }
        }
      });

    // Initialize the switch.
    triggerService.updateCharacteristic(this.hap.Characteristic.On, false);

    this.log.info("%s: Enabling motion sensor automation trigger.", this.name());

    return true;
  }

  // Configure a switch to manually trigger a doorbell ring event for HomeKit.
  private configureDoorbellTrigger(): boolean {

    const camera = (this.accessory.context.device as ProtectCameraConfig);

    // Find the switch service, if it exists.
    let triggerService = this.accessory.getServiceById(this.hap.Service.Switch, PROTECT_SWITCH_DOORBELL_TRIGGER);

    // See if we have a doorbell service configured.
    let doorbellService = this.accessory.getService(this.hap.Service.Doorbell);

    // Doorbell switches are disabled by default and primarily exist for automation purposes.
    if(!this.nvr?.optionEnabled(this.accessory.context.device as ProtectCameraConfig, "Doorbell.Trigger", false)) {

      if(triggerService) {
        this.accessory.removeService(triggerService);
      }

      // Since we aren't enabling the doorbell trigger on this camera, remove the doorbell service if the camera
      // isn't actually doorbell-capable hardware.
      if(!camera.featureFlags.hasChime && doorbellService) {
        this.accessory.removeService(doorbellService);
      }

      return false;
    }

    // We don't have a doorbell service configured, but since we've enabled a doorbell switch, we create the doorbell for
    // automation purposes.
    if(!doorbellService) {

      // Configure the doorbell service.
      if(!this.configureVideoDoorbell()) {
        return false;
      }

      // Now find the doorbell service.
      if(!(doorbellService = this.accessory.getService(this.hap.Service.Doorbell))) {
        this.log.error("%s: Unable to find the doorbell service.", this.name());
        return false;
      }
    }

    // Add the switch to the camera, if needed.
    if(!triggerService) {
      triggerService = new this.hap.Service.Switch(this.accessory.displayName + " Doorbell Trigger", PROTECT_SWITCH_DOORBELL_TRIGGER);

      if(!triggerService) {
        this.log.error("%s: Unable to add the doorbell trigger.", this.name());
        return false;
      }

      this.accessory.addService(triggerService);
    }

    // Trigger the doorbell.
    triggerService
      .getCharacteristic(this.hap.Characteristic.On)
      ?.onGet(() => {

        return this.isRinging;
      })
      .onSet((value: CharacteristicValue) => {

        if(value) {

          // Trigger the motion event.
          this.nvr.events.doorbellEventHandler(this.accessory, Date.now());
          this.log.info("%s: Doorbell ring event triggered.", this.name());

        } else {

          // If the doorbell ring event is still going, we should be as well.
          if(this.isRinging) {

            setTimeout(() => {
              triggerService?.updateCharacteristic(this.hap.Characteristic.On, true);
            }, 50);
          }
        }
      });

    // Initialize the switch.
    triggerService.updateCharacteristic(this.hap.Characteristic.On, false);

    this.log.info("%s: Enabling doorbell automation trigger.", this.name());

    return true;
  }

  // Configure the doorbell service for HomeKit.
  protected configureVideoDoorbell(): boolean {

    // Only configure the doorbell service if we haven't configured it before.
    if(this.isDoorbellConfigured) {
      return true;
    }

    // Find the doorbell service, if it exists.
    let doorbellService = this.accessory.getService(this.hap.Service.Doorbell);

    // Add the doorbell service to this Protect doorbell. HomeKit requires the doorbell service to be
    // marked as the primary service on the accessory.
    if(!doorbellService) {
      doorbellService = new this.hap.Service.Doorbell(this.accessory.displayName);

      if(!doorbellService) {
        this.log.error("%s: Unable to add doorbell.", this.name());
        return false;
      }

      this.accessory.addService(doorbellService);
    }

    doorbellService.setPrimaryService(true);
    this.isDoorbellConfigured = true;
    return true;
  }

  // Configure two-way audio support for HomeKit.
  private configureTwoWayAudio(): boolean {

    // Identify twoway-capable devices.
    if(!(this.accessory.context.device as ProtectCameraConfig).hasSpeaker) {
      return this.twoWayAudio = false;
    }

    // Enabled by default unless disabled by the user.
    return this.twoWayAudio = this.nvr?.optionEnabled(this.accessory.context.device as ProtectCameraConfig, "Audio") &&
      this.nvr?.optionEnabled(this.accessory.context.device as ProtectCameraConfig, "Audio.TwoWay");
  }

  // Configure additional camera-specific characteristics for HomeKit.
  private configureCameraDetails(): boolean {

    // Find the service, if it exists.
    const service = this.accessory.getService(this.hap.Service.CameraOperatingMode);

    // Grab our device context.
    const device = this.accessory.context.device as ProtectCameraConfig;

    // Turn the status light on or off.
    if(device.featureFlags.hasLedStatus) {

      service?.getCharacteristic(this.hap.Characteristic.CameraOperatingModeIndicator)
        ?.onGet(() => {

          return (this.accessory.context.device as ProtectCameraConfig).ledSettings?.isEnabled === true;
        })
        .onSet(async (value: CharacteristicValue) => {

          const ledState = value === true;

          // Update the status light in Protect.
          const newDevice = await this.nvr.nvrApi.updateCamera(this.accessory.context.device as ProtectCameraConfig, { ledSettings: { isEnabled: ledState } });

          if(!newDevice) {

            this.log.error("%s: Unable to turn the status light %s. Please ensure this username has the Administrator role in UniFi Protect.",
              this.name(), ledState ? "on" : "off");
            return;
          }

          // Set the context to our updated device configuration.
          this.accessory.context.device = newDevice;
        });


      // Initialize the status light state.
      service?.updateCharacteristic(this.hap.Characteristic.CameraOperatingModeIndicator, device.ledSettings.isEnabled === true);
    }

    return true;
  }

  // Find an RTSP configuration for a given target resolution.
  public findRtsp(width: number, height: number, camera: ProtectCameraConfig | null = null, address = "", rtspEntries = this.rtspEntries): RtspEntry | null {

    // No RTSP entries to choose from, we're done.
    if(!rtspEntries || !rtspEntries.length) {
      return null;
    }

    // First, we check to see if we've set an explicit preference for the target address.
    if(camera && address) {

      // If we don't have this address cached, look it up and cache it.
      if(!this.rtspQuality[address]) {

        // Check to see if there's an explicit preference set and cache the result.
        if(this.nvr.optionEnabled(camera, "Video.Stream.Only.Low", false, address, true)) {

          this.rtspQuality[address] = "LOW";
        } else if(this.nvr.optionEnabled(camera, "Video.Stream.Only.Medium", false, address, true)) {

          this.rtspQuality[address] = "MEDIUM";
        } else if(this.nvr.optionEnabled(camera, "Video.Stream.Only.High", false, address, true)) {

          this.rtspQuality[address] = "HIGH";
        } else {

          this.rtspQuality[address] = "None";
        }
      }

      // If it's set to none, we default to our normal lookup logic.
      if(this.rtspQuality[address] !== "None") {

        return rtspEntries.find(x => x.channel.name.toUpperCase() === this.rtspQuality[address]) ?? null;
      }
    }

    // Second, we check to see if we've set an explicit preference for stream quality.
    if(this.rtspQuality.Default) {
      return rtspEntries.find(x => x.channel.name.toUpperCase() === this.rtspQuality.Default) ?? null;
    }

    // See if we have a match for our desired resolution on the camera. We ignore FPS - HomeKit clients seem
    // to be able to handle it just fine.
    const exactRtsp = rtspEntries.find(x => (x.resolution[0] === width) && (x.resolution[1] === height));

    if(exactRtsp) {
      return exactRtsp;
    }

    // No match found, let's see what we have that's closest. We try to be a bit smart about how we select our
    // stream - if it's an HD quality stream request (720p+), we want to try to return something that's HD quality
    // before looking for something lower resolution.
    if((width >= 1280) && (height >= 720)) {

      for(const entry of rtspEntries) {

        // Make sure we're looking at an HD resolution.
        if(entry.resolution[0] < 1280) {
          continue;
        }

        // Return the first one we find.
        return entry;
      }
    }

    // If we didn't request an HD resolution, or we couldn't find anything HD to use, we try to find whatever we
    // can find that's close.
    for(const entry of rtspEntries) {
      if(width >= entry.resolution[0]) {
        return entry;
      }
    }

    // We couldn't find a close match, return the lowest resolution we found.
    return rtspEntries[rtspEntries.length - 1];
  }

  // Configure a camera accessory for HomeKit.
  public async configureVideoStream(): Promise<boolean> {

    const bootstrap: ProtectNvrBootstrap | null = this.nvr.nvrApi.bootstrap;
    let device = this.accessory.context.device as ProtectCameraConfig;
    const nvr: ProtectNvr = this.nvr;
    const nvrApi: ProtectApi = this.nvr.nvrApi;
    const rtspEntries: RtspEntry[] = [];

    // No channels exist on this camera or we don't have access to the bootstrap configuration.
    if(!device?.channels || !bootstrap) {
      return false;
    }

    // Enable RTSP on the camera if needed and get the list of RTSP streams we have ultimately configured.
    device = await nvrApi.enableRtsp(device) ?? device;

    // Figure out which camera channels are RTSP-enabled, and user-enabled.
    const cameraChannels = device.channels.filter(x => x.isRtspEnabled && nvr.optionEnabled(device, "Video.Stream." + x.name));

    // Make sure we've got a HomeKit compatible IDR frame interval. If not, let's take care of that.
    let idrChannels = cameraChannels.filter(x => x.idrInterval !== PROTECT_HOMEKIT_IDR_INTERVAL);

    if(idrChannels.length) {

      // Edit the channel map.
      idrChannels = idrChannels.map(x => {
        x.idrInterval = PROTECT_HOMEKIT_IDR_INTERVAL;
        return x;
      });

      device = await nvrApi.updateCamera(device, { channels: idrChannels }) ?? device;
      this.accessory.context.device = device;
    }

    // Set the camera and shapshot URLs.
    const cameraUrl = "rtsps://" + nvr.nvrAddress + ":" + bootstrap.nvr.ports.rtsps.toString() + "/";
    this.snapshotUrl = nvrApi.camerasUrl() + "/" + device.id + "/snapshot";

    // No RTSP streams are available that meet our criteria - we're done.
    if(!cameraChannels.length) {
      this.log.info("%s: No RTSP stream profiles have been configured for this camera. %s",
        this.name(),
        "Enable at least one RTSP stream profile in the UniFi Protect webUI to resolve this issue or " +
        "assign the Administrator role to the user configured for this plugin to allow it to automatically configure itself."
      );

      return false;
    }

    // Now that we have our RTSP streams, create a list of supported resolutions for HomeKit.
    for(const channel of cameraChannels) {

      // Sanity check in case Protect reports nonsensical resolutions.
      if(!channel.name || (channel.width <= 0) || (channel.width > 65535) || (channel.height <= 0) || (channel.height > 65535)) {
        continue;
      }

      rtspEntries.push({ channel: channel,
        name: this.getResolution([channel.width, channel.height, channel.fps]) + " (" + channel.name + ")",
        resolution: [ channel.width, channel.height, channel.fps ], url: cameraUrl + channel.rtspAlias + "?enableSrtp" });
    }

    // Sort the list of resolutions, from high to low.
    rtspEntries.sort(this.sortByResolutions.bind(this));

    // Next, ensure we have mandatory resolutions required by HomeKit, as well as special support for Apple TV and Apple Watch:
    //   3840x2160@30 (4k).
    //   1920x1080@30 (1080p).
    //   1280x720@30 (720p).
    //   320x240@15 (Apple Watch).
    for(const entry of [ [3840, 2160, 30], [1920, 1080, 30], [1280, 720, 30], [320, 240, 15] ] ) {

      // We already have this resolution in our list.
      if(rtspEntries.some(x => (x.resolution[0] === entry[0]) && (x.resolution[1] === entry[1]) && (x.resolution[2] === entry[2]))) {
        continue;
      }

      // Find the closest RTSP match for this resolution.
      const foundRtsp = this.findRtsp(entry[0], entry[1], undefined, undefined, rtspEntries);

      if(!foundRtsp) {
        continue;
      }

      // Add the resolution to the list of supported resolutions.
      rtspEntries.push({ channel: foundRtsp.channel, name: foundRtsp.name, resolution: [ entry[0], entry[1], entry[2] ], url: foundRtsp.url });

      // Since we added resolutions to the list, resort resolutions, from high to low.
      rtspEntries.sort(this.sortByResolutions.bind(this));
    }

    // Publish our updated list of supported resolutions and their URLs.
    this.rtspEntries = rtspEntries;

    // If we're already configured, we're done here.
    if(this.isVideoConfigured) {
      return true;
    }

    // Inform users about our RTSP entry mapping, if we're debugging.
    if(nvr.optionEnabled(device, "Debug.Video.Startup", false)) {
      for(const entry of this.rtspEntries) {
        this.log.info("%s: Mapping resolution: %s.", this.name(), this.getResolution(entry.resolution) + " => " + entry.name);
      }
    }

    // Check to see if the user has requested a specific stream quality for this camera.
    if(nvr.optionEnabled(device, "Video.Stream.Only.Low", false)) {
      this.rtspQuality.Default = "LOW";
    } else if(nvr.optionEnabled(device, "Video.Stream.Only.Medium", false)) {
      this.rtspQuality.Default = "MEDIUM";
    } else if(nvr.optionEnabled(device, "Video.Stream.Only.High", false)) {
      this.rtspQuality.Default = "HIGH";
    }

    // Inform the user if we've set a default.
    if(this.rtspQuality.Default) {
      this.log.info("%s: Configured to use only RTSP stream profile: %s.", this.name(),
        this.rtspQuality.Default.charAt(0) + this.rtspQuality.Default.slice(1).toLowerCase());
    }

    // Configure the video stream with our resolutions.
    this.stream = new ProtectStreamingDelegate(this, this.rtspEntries.map(x => x.resolution));

    // Fire up the controller and inform HomeKit about it.
    this.accessory.configureController(this.stream.controller);
    this.isVideoConfigured = true;

    return true;
  }

  // Configure HomeKit Secure Video support.
  private configureHksv(): boolean {

    const device = this.accessory.context.device as ProtectCameraConfig;

    // If we've explicitly disabled HomeKit Secure Video support, we're done.
    if(!this.nvr?.optionEnabled(this.accessory.context.device as ProtectCameraConfig, "Video.HKSV", true)) {

      this.log.info("%s: HomeKit Secure Video support disabled.", this.name());
      return false;
    }

    // HomeKit Secure Video support requires an enabled motion sensor. If one isn't enabled, we're done.
    if(!this.nvr?.optionEnabled(device, "Motion.Sensor")) {

      this.log.info("%s: Disabling HomeKit Secure Video support. You must enable motion sensor support in order to use HomeKit Secure Video.", this.name());
      return false;
    }

    this.isHksv = true;
    this.log.info("%s: HomeKit Secure Video support enabled.", this.name());

    // If we have smart motion events enabled, let's warn the user that things will not work quite the way they expect.
    if(device.featureFlags.hasSmartDetect && this.nvr?.optionEnabled(device, "Motion.SmartDetect", false)) {

      this.log.info("%s: WARNING: Smart motion detection and HomeKit Secure Video provide overlapping functionality. " +
        "Only HomeKit Secure Video, when event recording is enabled in the Home app, will be used to trigger motion event notifications for this camera." +
        (this.nvr?.optionEnabled(device, "Motion.SmartDetect.ObjectSensors", false) ?
          " Smart motion contact sensors will continue to function using telemetry from UniFi Protect." : ""), this.name());
    }

    return true;
  }

  // Configure a switch to manually enable or disable HKSV recording for a camera.
  private configureHksvRecordingSwitch(): boolean {

    // Find the switch service, if it exists.
    let switchService = this.accessory.getServiceById(this.hap.Service.Switch, PROTECT_SWITCH_HKSV_RECORDING);

    // If we don't have HKSV or the HKSV recording switch, disable the switch and we're done.
    if(!this.nvr?.optionEnabled(this.accessory.context.device as ProtectCameraConfig, "Video.HKSV") ||
      !this.nvr?.optionEnabled(this.accessory.context.device as ProtectCameraConfig, "Video.HKSV.Recording.Switch", false)) {

      if(switchService) {

        this.accessory.removeService(switchService);
      }

      // We want to default this back to recording whenever we disable the recording switch.
      this.accessory.context.hksvRecording;

      return false;
    }

    // Add the switch to the camera, if needed.
    if(!switchService) {

      switchService = new this.hap.Service.Switch(this.accessory.displayName + " HKSV Recording", PROTECT_SWITCH_HKSV_RECORDING);

      if(!switchService) {

        this.log.error("%s: Unable to add the HomeKit Secure Video recording switch.", this.name());
        return false;
      }

      this.accessory.addService(switchService);
    }

    // Activate or deactivate HKSV recording.
    switchService
      .getCharacteristic(this.hap.Characteristic.On)
      ?.onGet(() => {

        return this.accessory.context.hksvRecording as boolean;
      })
      .onSet((value: CharacteristicValue) => {

        if(this.accessory.context.hksvRecording !== value) {

          this.log.info("%s: HomeKit Secure Video event recording has been %s.", this.name(), value === true ? "enabled" : "disabled");
        }

        this.accessory.context.hksvRecording = value === true;
      });

    // Initialize the switch.
    switchService.updateCharacteristic(this.hap.Characteristic.On, this.accessory.context.hksvRecording as boolean);

    this.log.info("%s: Enabling HomeKit Secure Video recording switch.", this.name());

    return true;
  }

  // Configure MQTT capabilities of this camera.
  protected configureMqtt(): boolean {

    const bootstrap: ProtectNvrBootstrap | null = this.nvr.nvrApi.bootstrap;
    const device = (this.accessory.context.device as ProtectCameraConfig);

    // Return the RTSP URLs when requested.
    this.nvr.mqtt?.subscribe(this.accessory, "rtsp/get", (message: Buffer) => {
      const value = message.toString();

      // When we get the right message, we trigger the snapshot request.
      if(value?.toLowerCase() !== "true") {
        return;
      }

      const urlInfo: { [index: string]: string } = {};

      // Grab all the available RTSP channels.
      for(const channel of device.channels) {
        if(!bootstrap || !channel.isRtspEnabled) {
          continue;
        }

        urlInfo[channel.name] = "rtsps://" + bootstrap.nvr.host + ":" + bootstrap.nvr.ports.rtsp.toString() + "/" + channel.rtspAlias + "?enableSrtp";
      }

      this.nvr.mqtt?.publish(this.accessory, "rtsp", JSON.stringify(urlInfo));
      this.log.info("%s: RTSP information published via MQTT.", this.name());
    });

    // Trigger snapshots when requested.
    this.nvr.mqtt?.subscribe(this.accessory, "snapshot/trigger", (message: Buffer) => {
      const value = message.toString();

      // When we get the right message, we trigger the snapshot request.
      if(value?.toLowerCase() !== "true") {
        return;
      }

      void this.stream?.handleSnapshotRequest();
      this.log.info("%s: Snapshot triggered via MQTT.", this.name());
    });

    return true;
  }

  // Refresh camera-specific characteristics.
  public updateDevice(): boolean {

    // Grab our device context.
    const device = this.accessory.context.device as ProtectCameraConfig;

    // Find the service, if it exists.
    const service = this.accessory.getService(this.hap.Service.CameraOperatingMode);

    // Check to see if this device has a status light.
    if(device.featureFlags.hasLedStatus) {

      service?.updateCharacteristic(this.hap.Characteristic.CameraOperatingModeIndicator, device.ledSettings.isEnabled === true);
    }

    return true;
  }

  public getBitrate(channelId: number): number {

    // Grab the device JSON.
    const device = this.accessory.context.device as ProtectCameraConfig;

    // Find the right channel.
    const channel = device.channels.find(x => x.id === channelId);

    return channel?.bitrate ?? -1;
  }

  // Set the bitrate for a specific camera channel.
  public async setBitrate(channelId: number, value: number): Promise<boolean> {

    // If we've disabled the ability to set bitrates dynamically, silently fail.
    if(!this.nvr?.optionEnabled(this.accessory.context.device as ProtectCameraConfig, "Video.Dynamic.Bitrates", false)) {

      return true;
    }

    // Grab the device JSON.
    const device = this.accessory.context.device as ProtectCameraConfig;

    // Find the right channel.
    const channel = device.channels.find(x => x.id === channelId);

    // No channel, we're done.
    if(!channel) {

      return false;
    }

    // If our correct bitrate is already set, we're done.
    if(channel.bitrate === value) {

      return true;
    }

    // Make sure the requested bitrate fits within the constraints of what this channel can do.
    channel.bitrate = Math.min(channel.maxBitrate, Math.max(channel.minBitrate, value));

    // Tell Protect about it.
    const newDevice = await this.nvr.nvrApi.updateCamera(device, { channels: device.channels });

    if(!newDevice) {

      this.log.error("%s: Unable to set the streaming bitrate to %s.", this.name(), value);
      return false;
    }

    // Save our updated device context.
    this.accessory.context.device = newDevice;

    return true;
  }

  // Utility function for sorting by resolution.
  private sortByResolutions(a: RtspEntry, b: RtspEntry): number {

    // Check width.
    if(a.resolution[0] < b.resolution[0]) {
      return 1;
    }

    if(a.resolution[0] > b.resolution[0]) {
      return -1;
    }

    // Check height.
    if(a.resolution[1] < b.resolution[1]) {
      return 1;
    }

    if(a.resolution[1] > b.resolution[1]) {
      return -1;
    }

    // Check FPS.
    if(a.resolution[2] < b.resolution[2]) {
      return 1;
    }

    if(a.resolution[2] > b.resolution[2]) {
      return -1;
    }

    return 0;
  }

  // Utility function to format resolution entries.
  private getResolution(resolution: [number, number, number]): string {

    return resolution[0].toString() + "x" + resolution[1].toString() + "@" + resolution[2].toString() + "fps";
  }
}
