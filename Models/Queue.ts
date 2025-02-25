/**
 *
 * Queue Model
 *
 */

import uuid from 'react-native-uuid';
import promiseReflect from 'promise-reflect';
import _ from 'lodash';

import JobDatabase from '../config/Database';
import Worker from './Worker';


export class Queue {
  jobDB;
  worker;
  status;
  executeFailedJobsOnStart;
  /**
   *
   * Set initial class properties.
   *
   * @constructor
   *
   * @param executeFailedJobsOnStart {boolean} - Indicates if previously failed jobs will be executed on start (actually when created new job).
   */
  constructor(executeFailedJobsOnStart = false) {
    this.jobDB = null;
    this.worker = new Worker();
    this.status = 'inactive';
    this.executeFailedJobsOnStart = executeFailedJobsOnStart;
  }

  /**
   *
   * Initializes the queue by connecting to jobDB database.
   *
   */
  init = async () => {
    if (this.jobDB === null) {
      this.jobDB = new JobDatabase();
      await this.jobDB.init();
    }
  }

  /**
   *
   * Add a worker function to the queue.
   *
   * Worker will be called to execute jobs associated with jobName.
   *
   * Worker function will receive job id and job payload as parameters.
   *
   * Example:
   *
   * function exampleJobWorker(id, payload) {
   *  console.log(id); // UUID of job.
   *  console.log(payload); // Payload of data related to job.
   * }
   *
   * @param jobName {string} - Name associated with jobs assigned to this worker.
   * @param worker {function} - The worker function that will execute jobs.
   * @param options {object} - Worker options. See README.md for worker options info.
   */
  addWorker(jobName, worker, options = {}) {
    this.worker.addWorker(jobName, worker, options);
  }

  /**
   *
   * Delete worker function from queue.
   *
   * @param jobName {string} - Name associated with jobs assigned to this worker.
   */
  removeWorker(jobName) {
    this.worker.removeWorker(jobName);
  }

  /**
   *
   * Creates a new job and adds it to queue.
   *
   * Queue will automatically start processing unless startQueue param is set to false.
   *
   * @param name {string} - Name associated with job. The worker function assigned to this name will be used to execute this job.
   * @param payload {object} - Object of arbitrary data to be passed into worker function when job executes.
   * @param options {object} - Job related options like timeout etc. See README.md for job options info.
   * @param startQueue - {boolean} - Whether or not to immediately begin prcessing queue. If false queue.start() must be manually called.
   */
  createJob(name, payload = {}, options = {}, startQueue = true) {

    if (!name) {
      throw new Error('Job name must be supplied.');
    }

    // Validate options
    if (options.timeout < 0 || options.attempts < 0) {
      throw new Error('Invalid job option.');
    }

    // here we reset `failed` prop
    if (this.executeFailedJobsOnStart) {
      const jobs = this.jobDB.objects();

      for (let i = 0; i < jobs.length; i += 1) {
        jobs[i].failed = null;
      }

      this.jobDB.saveAll(jobs);

      this.executeFailedJobsOnStart = false;
    }

    this.jobDB.create({
      id: uuid.v4(),
      name,
      payload: JSON.stringify(payload),
      data: JSON.stringify({
        attempts: options.attempts || 1
      }),
      priority: options.priority || 0,
      active: false,
      timeout: (options.timeout >= 0) ? options.timeout : 25000,
      created: new Date(),
      failed: null,
    });

    // Start queue on job creation if it isn't running by default.
    if (startQueue && this.status === 'inactive') {
      this.start();
    }

  }

  /**
   *
   * Start processing the queue.
   *
   * If queue was not started automatically during queue.createJob(), this
   * method should be used to manually start the queue.
   *
   * If queue.start() is called again when queue is already running,
   * queue.start() will return early with a false boolean value instead
   * of running multiple queue processing loops concurrently.
   *
   * Lifespan can be passed to start() in order to run the queue for a specific amount of time before stopping.
   * This is useful, as an example, for OS background tasks which typically are time limited.
   *
   * NOTE: If lifespan is set, only jobs with a timeout property at least 500ms less than remaining lifespan will be processed
   * during queue processing lifespan. This is to buffer for the small amount of time required to query for suitable
   * jobs, and to mark such jobs as complete or failed when job finishes processing.
   *
   * IMPORTANT: Jobs with timeout set to 0 that run indefinitely will not be processed if the queue is running with a lifespan.
   *
   * @param lifespan {number} - If lifespan is passed, the queue will start up and run for lifespan ms, then queue will be stopped.
   * @return {boolean|undefined} - False if queue is already started. Otherwise nothing is returned when queue finishes processing.
   */
  async start(lifespan = 0) {

    // If queue is already running, don't fire up concurrent loop.
    if (this.status == 'active') {
      return false;
    }

    this.status = 'active';

    // Get jobs to process
    const startTime = Date.now();
    let lifespanRemaining = null;
    let concurrentJobs = [];

    if (lifespan !== 0) {
      lifespanRemaining = lifespan - (Date.now() - startTime);
      lifespanRemaining = (lifespanRemaining === 0) ? -1 : lifespanRemaining; // Handle exactly zero lifespan remaining edge case.
      concurrentJobs = await this.getConcurrentJobs(lifespanRemaining);
    } else {
      concurrentJobs = await this.getConcurrentJobs();
    }

    while (this.status === 'active' && concurrentJobs.length) {

      // Loop over jobs and process them concurrently.
      const processingJobs = concurrentJobs.map(job => {
        return this.processJob(job);
      });

      // Promise Reflect ensures all processingJobs resolve so
      // we don't break await early if one of the jobs fails.
      await Promise.all(processingJobs.map(promiseReflect));

      // Get next batch of jobs.
      if (lifespan !== 0) {
        lifespanRemaining = lifespan - (Date.now() - startTime);
        lifespanRemaining = (lifespanRemaining === 0) ? -1 : lifespanRemaining; // Handle exactly zero lifespan remaining edge case.
        concurrentJobs = await this.getConcurrentJobs(lifespanRemaining);
      } else {
        concurrentJobs = await this.getConcurrentJobs();
      }

    }

    this.status = 'inactive';

  }

  /**
   *
   * Stop processing queue.
   *
   * If queue.stop() is called, queue will stop processing until
   * queue is restarted by either queue.createJob() or queue.start().
   *
   */
  stop() {
    this.status = 'inactive';
  }

  /**
   *
   * Get a collection of all the jobs in the queue.
   *
   * @param sync {boolean} - This should be true if you want to guarantee job data is fresh. Otherwise you could receive job data that is not up to date if a write transaction is occuring concurrently.
   * @return {promise} - Promise that resolves to a collection of all the jobs in the queue.
   */
  async getJobs() {
    return this.jobDB.objects();
  }

  /**
   *
   * Get the next job(s) that should be processed by the queue.
   *
   * If the next job to be processed by the queue is associated with a
   * worker function that has concurrency X > 1, then X related (jobs with same name)
   * jobs will be returned.
   *
   * If queue is running with a lifespan, only jobs with timeouts at least 500ms < than REMAINING lifespan
   * AND a set timeout (ie timeout > 0) will be returned. See Queue.start() for more info.
   *
   * @param queueLifespanRemaining {number} - The remaining lifespan of the current queue process (defaults to indefinite).
   * @return {promise} - Promise resolves to an array of job(s) to be processed next by the queue.
   */
  async getConcurrentJobs(queueLifespanRemaining = 0) {

    let concurrentJobs = [];

    // Get next job from queue.
    let nextJob = null;

    // Build query string
    // If queueLife
    const timeoutUpperBound = (queueLifespanRemaining - 500 > 0) ? queueLifespanRemaining - 499 : 0; // Only get jobs with timeout at least 500ms < queueLifespanRemaining.

    let jobs = this.jobDB.objects();
    jobs = (queueLifespanRemaining)
      ? jobs.filter(j => (!j.active && j.failed === null && j.timeout > 0 && j.timeout < timeoutUpperBound))
      : jobs.filter(j => (!j.active && j.failed === null));
    jobs = _.orderBy(jobs, ['priority', 'created'], ['asc', 'asc']);
    // NOTE: here and below 'created' is sorted by 'asc' however in original it's 'desc'

    if (jobs.length) {
      nextJob = jobs[0];
    }

    // If next job exists, get concurrent related jobs appropriately.
    if (nextJob) {

      const concurrency = this.worker.getConcurrency(nextJob.name);

      let allRelatedJobs = this.jobDB.objects();
      allRelatedJobs = (queueLifespanRemaining) 
        ? allRelatedJobs.filter(j => (j.name === nextJob.name && !j.active && j.failed === null && j.timeout > 0 && j.timeout < timeoutUpperBound))
        : allRelatedJobs.filter(j => (j.name === nextJob.name && !j.active && j.failed === null));
      allRelatedJobs = _.orderBy(allRelatedJobs, ['priority', 'created'], ['asc', 'asc']);

      let jobsToMarkActive = allRelatedJobs.slice(0, concurrency);

      // Grab concurrent job ids to reselect jobs as marking these jobs as active will remove
      // them from initial selection when write transaction exits.
      // See: https://stackoverflow.com/questions/47359368/does-realm-support-select-for-update-style-read-locking/47363356#comment81772710_47363356
      const concurrentJobIds = jobsToMarkActive.map(job => job.id);

      // Mark concurrent jobs as active
      jobsToMarkActive = jobsToMarkActive.map(job => {
        job.active = true;
      });

      // Reselect now-active concurrent jobs by id.
      let reselectedJobs = this.jobDB.objects();
      reselectedJobs = reselectedJobs.filter(rj => _.includes(concurrentJobIds, rj.id));
      reselectedJobs = _.orderBy(reselectedJobs, ['priority', 'created'], ['asc', 'asc']);

      concurrentJobs = reselectedJobs.slice(0, concurrency);

    }

    return concurrentJobs;

  }

  /**
   *
   * Process a job.
   *
   * Job lifecycle callbacks are called as appropriate throughout the job processing lifecycle.
   *
   * Job is deleted upon successful completion.
   *
   * If job fails execution via timeout or other exception, error will be
   * logged to job.data.errors array and job will be reset to inactive status.
   * Job will be re-attempted up to the specified "attempts" setting (defaults to 1),
   * after which it will be marked as failed and not re-attempted further.
   *
   * @param job {object} - Job model object
   */
  async processJob(job) {

    // Data must be cloned off the job object for several lifecycle callbacks to work correctly.
    // This is because job is deleted before some callbacks are called if job processed successfully.
    // More info: https://github.com/billmalarky/react-native-queue/issues/2#issuecomment-361418965
    const jobName = job.name;
    const jobId = job.id;
    const jobPayload = JSON.parse(job.payload);

    // Fire onStart job lifecycle callback
    this.worker.executeJobLifecycleCallback('onStart', jobName, jobId, jobPayload);

    try {
      const executionResult = await this.worker.executeJob(job); // here we catch js/network errors
      
      if (!executionResult.ok) throw new Error('Execution failure'); // here we catch http errors

      // On successful job completion, remove job
      this.jobDB.delete(job);

      // Job has processed successfully, fire onSuccess and onComplete job lifecycle callbacks.
      this.worker.executeJobLifecycleCallback('onSuccess', jobName, jobId, jobPayload);
      this.worker.executeJobLifecycleCallback('onComplete', jobName, jobId, jobPayload);

    } catch (error) {
      // Handle job failure logic, including retries.
      let jobData = JSON.parse(job.data);

      // Increment failed attempts number
      if (!jobData.failedAttempts) {
        jobData.failedAttempts = 1;
      } else {
        jobData.failedAttempts++;
      }

      // Log error
      if (!jobData.errors) {
        jobData.errors = [error.message];
      } else {
        jobData.errors.push(error.message);
      }

      job.data = JSON.stringify(jobData);

      // Reset active status
      job.active = false;

      // Mark job as failed if too many attempts
      if (jobData.failedAttempts >= jobData.attempts) {
        job.failed = new Date();
      }

      this.jobDB.save(job);

      // Execute job onFailure lifecycle callback.

      if ( // filter network errors
        error.message.indexOf('TIMEOUT') !== -1 ||
        error.message.indexOf('Network request failed') !== -1
      ) return false;

      if (jobData.failedAttempts === 1 || jobData.failedAttempts === jobData.attempts) { // report only first and last error
        this.worker.executeJobLifecycleCallback('onFailure', jobName, jobId, jobPayload, error);
      }

      // If job has failed all attempts execute job onFailed and onComplete lifecycle callbacks.
      if (jobData.failedAttempts >= jobData.attempts) {
        this.worker.executeJobLifecycleCallback('onFailed', jobName, jobId, jobPayload, error);
        this.worker.executeJobLifecycleCallback('onComplete', jobName, jobId, jobPayload);
      }

    }

  }

  /**
   *
   * Delete jobs in the queue.
   *
   * If jobName is supplied, only jobs associated with that name
   * will be deleted. Otherwise all jobs in queue will be deleted.
   *
   * @param jobName {string} - Name associated with job (and related job worker).
   */
  async flushQueue(jobName = null) {

    if (jobName) {

      let jobs = this.jobDB.objects();
      jobs = jobs.filter(j => j.name === jobName);

      if (jobs.length) {
        // NOTE: might not work
        this.jobDB.delete(jobs);
      }

    } else {
      this.jobDB.deleteAll();
    }

  }

}

/**
 *
 * Factory should be used to create a new queue instance.
 *
 * @param executeFailedJobsOnStart {boolean} - Indicates if previously failed jobs will be executed on start (actually when created new job).
 *
 * @return {Queue} - A queue instance.
 */
export default async function queueFactory(executeFailedJobsOnStart = false) {

  const queue = new Queue(executeFailedJobsOnStart);
  await queue.init();

  return queue;

}
